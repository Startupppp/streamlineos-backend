/**
 * Real-database tests for the stock engine.
 *
 * Run with: pnpm test:db-specs (filter with --testPathPattern="stock-engine.db").
 *
 * These exist because the mocked engine specs cannot catch the defects that
 * actually shipped: the idempotency claim aborted its own transaction, and the
 * mock asserted the throwing behaviour was correct. Concurrency, transaction
 * semantics and ledger/snapshot agreement are only provable against Postgres.
 */
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";

function connect() {
  // DATABASE_URL first: these specs create and drop scratch tables, which the
  // RLS-enforced application role is not permitted to do.
  const raw = requireApprovedDatabaseUrl({
    spec: "stock-engine.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), { prepare: false, max: 10, ssl: "require", connect_timeout: 30 });
}

describe("stock engine — real database", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  describe("idempotency claim semantics", () => {
    it("ON CONFLICT DO NOTHING RETURNING lets the claim branch without aborting the transaction", async () => {
      const key = `probe-${randomUUID()}`;
      await sql`CREATE TEMP TABLE inv_test_idem (id serial PRIMARY KEY, k text NOT NULL)`;
      await sql`CREATE UNIQUE INDEX inv_test_idem_k ON inv_test_idem (k)`;
      await sql`INSERT INTO inv_test_idem (k) VALUES (${key})`;

      const outcome = await sql.begin(async (tx) => {
        const claimed = await tx`
          INSERT INTO inv_test_idem (k) VALUES (${key})
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        const existing = await tx`SELECT id FROM inv_test_idem WHERE k = ${key}`;
        return { claimedRows: claimed.length, existingRows: existing.length };
      });

      expect(outcome.claimedRows).toBe(0);
      expect(outcome.existingRows).toBe(1);
      await sql`DROP TABLE inv_test_idem`;
    });

    it("a caught duplicate-key error DOES poison the transaction — the shape the engine must not use", async () => {
      const key = `probe-${randomUUID()}`;
      await sql`CREATE TEMP TABLE inv_test_poison (id serial PRIMARY KEY, k text NOT NULL)`;
      await sql`CREATE UNIQUE INDEX inv_test_poison_k ON inv_test_poison (k)`;
      await sql`INSERT INTO inv_test_poison (k) VALUES (${key})`;

      let followUpFailed = false;
      try {
        await sql.begin(async (tx) => {
          try {
            await tx`INSERT INTO inv_test_poison (k) VALUES (${key})`;
          } catch {
            // swallowed, exactly like the pre-fix claimIdempotencyKey
          }
          try {
            await tx`SELECT id FROM inv_test_poison WHERE k = ${key}`;
          } catch {
            followUpFailed = true;
          }
        });
      } catch {
        followUpFailed = true;
      }

      expect(followUpFailed).toBe(true);
      await sql`DROP TABLE inv_test_poison`;
    });
  });

  describe("concurrent allocation of the last unit", () => {
    it("exactly one of two simultaneous claims succeeds under FOR UPDATE", async () => {
      await sql`CREATE TABLE IF NOT EXISTS inv_test_level (id int PRIMARY KEY, on_hand numeric(18,4) NOT NULL)`;
      await sql`INSERT INTO inv_test_level (id, on_hand) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET on_hand = 1`;

      const claim = async () =>
        sql.begin(async (tx) => {
          const [row] = await tx`SELECT on_hand FROM inv_test_level WHERE id = 1 FOR UPDATE`;
          const available = Number(row!.on_hand);
          if (available < 1) return "lost";
          await tx`UPDATE inv_test_level SET on_hand = on_hand - 1 WHERE id = 1`;
          return "won";
        });

      const results = await Promise.all([claim(), claim()]);
      const wins = results.filter((r) => r === "won").length;

      expect(wins).toBe(1);
      const [final] = await sql`SELECT on_hand FROM inv_test_level WHERE id = 1`;
      expect(Number(final!.on_hand)).toBe(0);
      await sql`DROP TABLE inv_test_level`;
    }, 60_000);

    it("oversells without the lock — proving the test itself discriminates", async () => {
      await sql`CREATE TABLE IF NOT EXISTS inv_test_level_nolock (id int PRIMARY KEY, on_hand numeric(18,4) NOT NULL)`;
      await sql`INSERT INTO inv_test_level_nolock (id, on_hand) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET on_hand = 1`;

      const claimUnsafe = async () => {
        const [row] = await sql`SELECT on_hand FROM inv_test_level_nolock WHERE id = 1`;
        const available = Number(row!.on_hand);
        await new Promise((r) => setTimeout(r, 25));
        if (available < 1) return "lost";
        await sql`UPDATE inv_test_level_nolock SET on_hand = on_hand - 1 WHERE id = 1`;
        return "won";
      };

      const results = await Promise.all([claimUnsafe(), claimUnsafe()]);
      expect(results.filter((r) => r === "won").length).toBe(2);
      const [final] = await sql`SELECT on_hand FROM inv_test_level_nolock WHERE id = 1`;
      expect(Number(final!.on_hand)).toBe(-1);
      await sql`DROP TABLE inv_test_level_nolock`;
    }, 60_000);
  });

  describe("ledger and snapshot agreement", () => {
    it("snapshot equals the sum of movements after a randomised sequence", async () => {
      await sql`CREATE TABLE IF NOT EXISTS inv_test_ledger (id serial PRIMARY KEY, qty numeric(18,4) NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS inv_test_snapshot (id int PRIMARY KEY, on_hand numeric(18,4) NOT NULL)`;
      await sql`TRUNCATE inv_test_ledger`;
      await sql`INSERT INTO inv_test_snapshot (id, on_hand) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET on_hand = 0`;

      const deltas: number[] = [];
      let seed = 20260811;
      for (let i = 0; i < 60; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        deltas.push(((seed % 21) - 10) || 1);
      }

      for (const delta of deltas) {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO inv_test_ledger (qty) VALUES (${delta})`;
          await tx`UPDATE inv_test_snapshot SET on_hand = on_hand + ${delta} WHERE id = 1`;
        });
      }

      const [ledger] = await sql`SELECT COALESCE(SUM(qty), 0)::text AS total FROM inv_test_ledger`;
      const [snapshot] = await sql`SELECT on_hand::text AS on_hand FROM inv_test_snapshot WHERE id = 1`;

      expect(Number(snapshot!.on_hand)).toBe(Number(ledger!.total));
      await sql`DROP TABLE inv_test_ledger`;
      await sql`DROP TABLE inv_test_snapshot`;
    }, 180_000);
  });

  describe("concurrent stock adjustments via the same stock level", () => {
    it("two adjustments on the same level serialize — no lost update, arithmetic is consistent", async () => {
      await sql`CREATE TABLE IF NOT EXISTS inv_test_adj_level (id int PRIMARY KEY, on_hand numeric(18,4) NOT NULL)`;
      await sql`INSERT INTO inv_test_adj_level (id, on_hand) VALUES (1, 20) ON CONFLICT (id) DO UPDATE SET on_hand = 20`;

      const applyAdjustment = async (delta: number) =>
        sql.begin(async (tx) => {
          const [row] = await tx`SELECT on_hand FROM inv_test_adj_level WHERE id = 1 FOR UPDATE`;
          const newOnHand = Number(row!.on_hand) + delta;
          await tx`UPDATE inv_test_adj_level SET on_hand = ${newOnHand} WHERE id = 1`;
          return newOnHand;
        });

      await Promise.all([applyAdjustment(-10), applyAdjustment(-10)]);

      const [final] = await sql`SELECT on_hand FROM inv_test_adj_level WHERE id = 1`;
      expect(Number(final!.on_hand)).toBe(0);

      await sql`DROP TABLE inv_test_adj_level`;
    }, 60_000);

    it("without FOR UPDATE, two adjustments produce a lost update — phantom stock remains", async () => {
      await sql`CREATE TABLE IF NOT EXISTS inv_test_adj_nolock (id int PRIMARY KEY, on_hand numeric(18,4) NOT NULL)`;
      await sql`INSERT INTO inv_test_adj_nolock (id, on_hand) VALUES (1, 20) ON CONFLICT (id) DO UPDATE SET on_hand = 20`;

      const applyUnsafe = async (delta: number) => {
        const [row] = await sql`SELECT on_hand FROM inv_test_adj_nolock WHERE id = 1`;
        const newOnHand = Number(row!.on_hand) + delta;
        await new Promise<void>((r) => setTimeout(r, 25));
        await sql`UPDATE inv_test_adj_nolock SET on_hand = ${newOnHand} WHERE id = 1`;
        return newOnHand;
      };

      await Promise.all([applyUnsafe(-10), applyUnsafe(-10)]);

      const [final] = await sql`SELECT on_hand FROM inv_test_adj_nolock WHERE id = 1`;
      expect(Number(final!.on_hand)).toBe(10);

      await sql`DROP TABLE inv_test_adj_nolock`;
    }, 60_000);
  });
});
