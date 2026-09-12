/**
 * Real-database tests for the stock engine.
 *
 * Runs when DATABASE_URL is set, so the default hermetic `jest` run is
 * unaffected and CI without a database skips loudly rather than failing:
 *   DATABASE_URL=... pnpm test:db --testPathPattern="stock-engine.db"
 *
 * These exist because the mocked engine specs cannot catch the defects that
 * actually shipped: the idempotency claim aborted its own transaction, and the
 * mock asserted the throwing behaviour was correct. Concurrency, transaction
 * semantics and ledger/snapshot agreement are only provable against Postgres.
 */
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { dbSpecClient, dbSpecSessionClient, dbSpecSuite } from "../../../../test/db-spec-gate";

const describeDb = dbSpecSuite();

/**
 * The URL, refused unless the destructive-spec guard approves its target: these
 * probes create and drop scratch tables, so they must never reach a database
 * nobody opted in to.
 */
function approvedDatabaseUrl(): string {
  return requireApprovedDatabaseUrl({
    spec: "stock-engine.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
}

function connect() {
  // DATABASE_URL first: these specs create and drop scratch tables, which the
  // RLS-enforced application role is not permitted to do.
  return dbSpecClient(approvedDatabaseUrl(), { max: 10 });
}

/**
 * A session-mode connection, for the probes that need one.
 *
 * DATABASE_URL points at the transaction-mode pooler, which hands out a
 * different backend per transaction. A TEMP TABLE created on one is invisible to
 * the next and outlives the test in some pooler backend's pg_temp, so a rerun
 * collides with a table it cannot see: both probes failed that way, and the
 * failure looked like a defect in the thing being probed. Neon encodes session
 * mode in the host, the same substitution db-verify-rls.mjs makes.
 */
function connectSession() {
  return dbSpecSessionClient(approvedDatabaseUrl());
}

describeDb("stock engine — real database", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  describe("idempotency claim semantics", () => {
    // A TEMP TABLE belongs to one session, and this pool holds ten. Created on
    // one connection and used from another, it simply does not exist -- which is
    // how both of these read as failures while proving nothing about the engine.
    // Reserving a connection makes the whole probe run in one session.
    it("ON CONFLICT DO NOTHING RETURNING lets the claim branch without aborting the transaction", async () => {
      const key = `probe-${randomUUID()}`;
      const table = `inv_test_idem_${randomUUID().replace(/-/g, "")}`;
      const session = connectSession();
      try {
        await session.unsafe(`CREATE TEMP TABLE ${table} (id serial PRIMARY KEY, k text NOT NULL)`);
        await session.unsafe(`CREATE UNIQUE INDEX ${table}_k ON ${table} (k)`);
        await session.unsafe(`INSERT INTO ${table} (k) VALUES ($1)`, [key]);

        const outcome = await session.begin(async (tx) => {
          const claimed = await tx.unsafe(
            `INSERT INTO ${table} (k) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`,
            [key],
          );
          // The transaction must still be usable — this is the read the engine
          // performs to decide between replay and reclaim.
          const existing = await tx.unsafe(`SELECT id FROM ${table} WHERE k = $1`, [key]);
          return { claimedRows: claimed.length, existingRows: existing.length };
        });

        expect(outcome.claimedRows).toBe(0);
        expect(outcome.existingRows).toBe(1);
      } finally {
        await session.end({ timeout: 5 });
      }
    });

    it("a caught duplicate-key error DOES poison the transaction — the shape the engine must not use", async () => {
      const key = `probe-${randomUUID()}`;
      const table = `inv_test_poison_${randomUUID().replace(/-/g, "")}`;
      const session = connectSession();
      try {
        await session.unsafe(`CREATE TEMP TABLE ${table} (id serial PRIMARY KEY, k text NOT NULL)`);
        await session.unsafe(`CREATE UNIQUE INDEX ${table}_k ON ${table} (k)`);
        await session.unsafe(`INSERT INTO ${table} (k) VALUES ($1)`, [key]);

        let followUpFailed = false;
        try {
          await session.begin(async (tx) => {
            try {
              await tx.unsafe(`INSERT INTO ${table} (k) VALUES ($1)`, [key]);
            } catch {
              // swallowed, exactly like the pre-fix claimIdempotencyKey
            }
            try {
              await tx.unsafe(`SELECT id FROM ${table} WHERE k = $1`, [key]);
            } catch {
              followUpFailed = true;
            }
          });
        } catch {
          followUpFailed = true;
        }

        expect(followUpFailed).toBe(true);
      } finally {
        await session.end({ timeout: 5 });
      }
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
