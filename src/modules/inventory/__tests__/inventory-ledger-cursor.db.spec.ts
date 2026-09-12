/**
 * G1 — the ledger cursor, against a real database.
 *
 * A keyset can be wrong in three ways that nothing else catches. It can be
 * built on a key that is not a total order, and then a page boundary that lands
 * inside a group of rows sharing a timestamp skips or repeats them. It can be
 * built on a boundary the driver has already truncated, and then rows in the
 * truncated interval vanish from the middle of the walk with every page still
 * looking full. And it can be correct in isolation and still not survive the
 * table being written to underneath it. None of the three is visible to a unit
 * test with a mocked database, because all three are about what Postgres does
 * with the predicate.
 *
 *   DATABASE_URL=... pnpm test:db --testPathPattern="inventory-ledger-cursor"
 */
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
// The relational query builder needs the whole schema map to resolve `with`
// clauses; this spec reads only `inv_stock_transactions` through it and
// touches no legacy identity table.
// eslint-disable-next-line no-restricted-imports
import * as schema from "../../../db/schema";
import { invStockTransactions } from "../../../db/schema";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import { decodeTimestampCursor } from "../../../common/pagination/cursor";
import { InvStockService } from "../stock/inv-stock.service";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../test/db-spec-gate";
import { ensureFixtureLedger, ensureFixtureOrgs } from "../../../test/db-spec-fixture";

const describeDb = dbSpecSuite();

const PAGE = 25;
const MAX_PAGES = 6;

describeDb("inventory ledger cursor", () => {
  let client: ReturnType<typeof postgres>;
  let service: InvStockService;
  let orgId: string;

  beforeAll(async () => {
    client = dbSpecClient(dbSpecUrl("DATABASE_URL"), { max: 1 });

    // A walk that never crosses a page boundary proves nothing about a keyset,
    // and a freshly migrated database has no ledger at all — which used to throw
    // "no seeded ledger to walk" out of beforeAll and fail every assertion here
    // with jest's own message. Seed a floor when the database cannot supply one.
    const [busiest] = await client<{ org_id: string; n: number }[]>`
      SELECT org_id, count(*)::int AS n FROM inv_stock_transactions
      GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`;
    if (busiest && busiest.n > PAGE) {
      orgId = busiest.org_id;
    } else {
      const [fixture] = await ensureFixtureOrgs(client, 1);
      await ensureFixtureLedger(client, fixture!);
      orgId = fixture!.orgId;
    }

    // The service's collaborators are all policy, not data: the walk under test
    // is the one query. Neutralising them keeps the assertions about the cursor.
    const db = drizzle(client, { schema });
    service = new InvStockService(
      db as never,
      { cachedVersioned: async (_k: string, _h: string, fn: () => unknown) => fn() } as never,
      { resolve: async () => null, locationPredicate: () => sql`TRUE` } as never,
      { canSeeCost: async () => true } as never,
    );
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("emits the tuple bound as an index-usable row comparison, cast in SQL", () => {
    const query = new PgDialect().sqlToQuery(
      keysetBeforeMicros(invStockTransactions.createdAt, invStockTransactions.id, {
        sortValue: "2026-08-28T08:51:46.541218",
        id: 49253,
      }),
    );

    expect(query.sql).toBe(
      '("inv_stock_transactions"."created_at", "inv_stock_transactions"."id") < ($1::timestamp, $2)',
    );
    // Bound as text, never as a Date — rebuilding it as a Date is the truncation.
    expect(query.params[0]).toBe("2026-08-28T08:51:46.541218");
    expect(query.params[0]).not.toBeInstanceOf(Date);
    expect(query.params[1]).toBe(49253);
  });

  it("walks every row exactly once, in the same order the unpaged query returns", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (; pages < MAX_PAGES; pages++) {
      const result = await service.listTransactions(orgId, "probe-user", {
        page: 1,
        limit: PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map((item) => item.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor ?? undefined;
      expect(cursor).toBeDefined();
    }

    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);

    const expected = await client<{ id: number }[]>`
      SELECT id FROM inv_stock_transactions
      WHERE org_id = ${orgId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${seen.length}`;
    expect(seen).toEqual(expected.map((row) => row.id));
  });

  it("counts on the offset page and refuses to on a cursor page", async () => {
    const first = await service.listTransactions(orgId, "probe-user", { page: 1, limit: PAGE });
    expect(typeof first.total).toBe("number");
    expect(typeof first.totalPages).toBe("number");
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listTransactions(orgId, "probe-user", {
      page: 1,
      limit: PAGE,
      cursor: first.nextCursor ?? "",
    });
    // `count(*)` over a tenant's ledger is the cost a cursor exists to avoid.
    expect(second.total).toBeNull();
    expect(second.totalPages).toBeNull();
  });

  it("carries the boundary at microsecond precision, not the driver's milliseconds", async () => {
    const first = await service.listTransactions(orgId, "probe-user", { page: 1, limit: 1 });
    const position = decodeTimestampCursor(first.nextCursor);
    if (!position) throw new Error("the first page produced no usable cursor");

    const [row] = await client<{ exact: string; via_driver_ms: string }[]>`
      SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS exact,
             to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD"T"HH24:MI:SS.US') AS via_driver_ms
      FROM inv_stock_transactions WHERE org_id = ${orgId} AND id = ${position.id}`;
    if (!row) throw new Error("the cursor named a row that is not there");

    expect(position.sortValue).toBe(row.exact);
    expect(position.sortValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    // The point of the whole exercise: had the boundary gone through a JS Date
    // it would be this instead, and every row between the two is one a page
    // would silently drop.
    expect(row.via_driver_ms.endsWith("000")).toBe(true);
  });

  it("rejects a tampered or stale cursor by falling back to the first page", async () => {
    const clean = await service.listTransactions(orgId, "probe-user", { page: 1, limit: 5 });

    for (const bad of [
      "not-a-cursor",
      Buffer.from("2026-08-28T08:51:46.541218 abc", "utf8").toString("base64url"),
      Buffer.from("2026-08-28T08:51:46.541218 -1", "utf8").toString("base64url"),
      Buffer.from("'; DROP TABLE inv_stock_transactions; -- 1", "utf8").toString("base64url"),
      Buffer.from("2026-08-28T08:51:46.5412 1", "utf8").toString("base64url"),
    ]) {
      const result = await service.listTransactions(orgId, "probe-user", {
        page: 1,
        limit: 5,
        cursor: bad,
      });
      expect(result.items.map((item) => item.id)).toEqual(clean.items.map((item) => item.id));
    }
  });

  /**
   * The properties above are about the real ledger, which nothing may write to
   * from a test. Everything below needs rows placed at chosen microseconds and
   * rows appearing mid-walk, so it runs against a transaction-local table with
   * the ledger's shape and is rolled back — nothing is ever committed.
   */
  describe("under concurrent inserts", () => {
    const BOUNDARY = "2026-08-28T12:00";

    it("returns every row exactly once even when the table is written to between pages", async () => {
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe(`
            CREATE TEMP TABLE g1_ledger_probe (
              id int primary key,
              created_at timestamp not null
            ) ON COMMIT DROP`);

          // Ten rows sharing one microsecond — one posting writing ten lines —
          // then four more inside the same millisecond as the tenth. A cursor on
          // the timestamp alone cannot separate either group.
          await tx.unsafe(`
            INSERT INTO g1_ledger_probe (id, created_at) VALUES
              (1,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (2,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (3,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (4,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (5,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (6,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (7,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (8,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (9,  TIMESTAMP '${BOUNDARY}:00.000000'),
              (10, TIMESTAMP '${BOUNDARY}:00.000000'),
              (11, TIMESTAMP '${BOUNDARY}:01.000100'),
              (12, TIMESTAMP '${BOUNDARY}:01.000500'),
              (13, TIMESTAMP '${BOUNDARY}:01.000900'),
              (14, TIMESTAMP '${BOUNDARY}:01.001000'),
              (15, TIMESTAMP '${BOUNDARY}:02.000000')`);

          const ordered = await tx.unsafe<{ id: number }[]>(
            `SELECT id FROM g1_ledger_probe ORDER BY created_at DESC, id DESC`,
          );
          const expected = ordered.map((row) => row.id);

          const page = async (cursor: { sortValue: string; id: number } | null, limit: number) =>
            tx.unsafe<{ id: number; cursor_at: string }[]>(
              `SELECT id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at
               FROM g1_ledger_probe
               ${cursor ? `WHERE (created_at, id) < ($1::timestamp, $2)` : ""}
               ORDER BY created_at DESC, id DESC
               LIMIT ${limit + 1}`,
              cursor ? [cursor.sortValue, cursor.id] : [],
            );

          const seen: number[] = [];
          let cursor: { sortValue: string; id: number } | null = null;
          let inserted = false;

          for (let guard = 0; guard < 20; guard++) {
            const rows = await page(cursor, 3);
            const hasMore = rows.length > 3;
            const data = hasMore ? rows.slice(0, 3) : rows;
            seen.push(...data.map((row) => row.id));
            if (!hasMore) break;
            const last = data[data.length - 1];
            if (!last) break;
            cursor = { sortValue: last.cursor_at, id: last.id };

            if (!inserted) {
              inserted = true;
              // Two writers arriving mid-walk. 99 is newer than anything the
              // reader has seen and belongs on a page already turned; 50 lands
              // in the middle of the tie group the cursor is standing in.
              await tx.unsafe(`
                INSERT INTO g1_ledger_probe (id, created_at) VALUES
                  (99, TIMESTAMP '${BOUNDARY}:09.000000'),
                  (50, TIMESTAMP '${BOUNDARY}:00.000000')`);
            }
          }

          expect(new Set(seen).size).toBe(seen.length);
          // 99 was written above the cursor, so it is on no page left to turn.
          expect(seen).not.toContain(99);
          // 50 was written below it, so it arrives in its proper place.
          expect(seen).toContain(50);
          expect(seen.filter((id) => id !== 50)).toEqual(expected);

          throw new Error("ROLLBACK: the probe table must never commit");
        }),
      ).rejects.toThrow("ROLLBACK");
    }, 60_000);

    it("would drop rows if the boundary were truncated to milliseconds", async () => {
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe(`
            CREATE TEMP TABLE g1_precision_probe (
              id int primary key,
              created_at timestamp not null
            ) ON COMMIT DROP`);
          await tx.unsafe(`
            INSERT INTO g1_precision_probe (id, created_at) VALUES
              (1, TIMESTAMP '${BOUNDARY}:01.000900'),
              (2, TIMESTAMP '${BOUNDARY}:01.000500'),
              (3, TIMESTAMP '${BOUNDARY}:01.000100'),
              (4, TIMESTAMP '${BOUNDARY}:00.000000')`);

          const exact = await tx.unsafe<{ id: number }[]>(
            `SELECT id FROM g1_precision_probe
             WHERE (created_at, id) < ('${BOUNDARY}:01.000900'::timestamp, 1)
             ORDER BY created_at DESC, id DESC`,
          );
          const truncated = await tx.unsafe<{ id: number }[]>(
            `SELECT id FROM g1_precision_probe
             WHERE (created_at, id) < ('${BOUNDARY}:01.000000'::timestamp, 1)
             ORDER BY created_at DESC, id DESC`,
          );

          expect(exact.map((row) => row.id)).toEqual([2, 3, 4]);
          // Rows 2 and 3 are strictly older than row 1 and are simply gone. The
          // page is still full, the ids are still unique, the walk still ends.
          expect(truncated.map((row) => row.id)).toEqual([4]);

          throw new Error("ROLLBACK: the probe table must never commit");
        }),
      ).rejects.toThrow("ROLLBACK");
    }, 60_000);
  });

  it("projects the boundary from the column it orders by", () => {
    const query = new PgDialect().sqlToQuery(microsecondCursorValue(invStockTransactions.createdAt));
    expect(query.sql).toBe(
      `to_char("inv_stock_transactions"."created_at", 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
    );
  });
});
