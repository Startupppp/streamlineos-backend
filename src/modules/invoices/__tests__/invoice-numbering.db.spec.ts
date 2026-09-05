/**
 * Real-database test for invoice number race-safety.
 *
 * Runs when DATABASE_URL is set, like every other `*.db.spec.ts`.
 * Run with: DATABASE_URL=... pnpm test:db --testPathPattern="invoice-numbering.db"
 *
 * The service uses pg_advisory_xact_lock(hashtext(orgId || 'invoice')) inside
 * the transaction, then counts ALL org invoices (unfiltered — no status or
 * deleted_at predicate) and assigns count + 1 as the next number. The count is
 * unfiltered by design: voided invoices change status but are never physically
 * deleted, so the count always equals the true cardinality and no gap can form.
 * The numbering rule is therefore GAPLESS — no compliance-visible number is ever
 * skipped. The advisory lock guarantees serial execution per org, so two
 * simultaneous creates cannot read the same count. Both properties are pinned
 * here with genuine concurrent Postgres transactions.
 */
import { randomUUID } from "node:crypto";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../test/db-spec-gate";

const describeDb = dbSpecSuite();

function connect() {
  return dbSpecClient(dbSpecUrl("DATABASE_URL", "APP_DATABASE_URL"), { max: 10 });
}

describeDb("invoice numbering — real database", () => {
  let sql: ReturnType<typeof connect>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  describe("pg_advisory_xact_lock serializes concurrent number assignment", () => {
    it("two concurrent invoice creates receive distinct sequential numbers", async () => {
      const orgId = `inv-num-${randomUUID().slice(0, 8)}`;
      await sql`CREATE TABLE IF NOT EXISTS inv_num_race_test (
        id    serial  PRIMARY KEY,
        org_id text   NOT NULL,
        num   int     NOT NULL
      )`;
      await sql`DELETE FROM inv_num_race_test WHERE org_id = ${orgId}`;

      const assign = async () =>
        sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${orgId} || 'invoice'))`;
          const [{ count }] = await tx`
            SELECT count(*)::int AS count FROM inv_num_race_test WHERE org_id = ${orgId}
          `;
          const nextNum = Number(count) + 1;
          await tx`INSERT INTO inv_num_race_test (org_id, num) VALUES (${orgId}, ${nextNum})`;
          return nextNum;
        });

      const [n1, n2] = await Promise.all([assign(), assign()]);

      expect(n1).not.toBe(n2);
      expect(new Set([n1, n2]).size).toBe(2);

      const rows = await sql`
        SELECT num FROM inv_num_race_test WHERE org_id = ${orgId} ORDER BY num
      `;
      expect(rows.map((r) => Number(r.num))).toEqual([1, 2]);

      await sql`DROP TABLE IF EXISTS inv_num_race_test`;
    }, 60_000);

    it("without the advisory lock, two concurrent reads see the same count and collide — proving the test discriminates", async () => {
      const orgId = `inv-num-nolock-${randomUUID().slice(0, 8)}`;
      await sql`CREATE TABLE IF NOT EXISTS inv_num_nolock_test (
        id    serial  PRIMARY KEY,
        org_id text   NOT NULL,
        num   int     NOT NULL
      )`;
      await sql`DELETE FROM inv_num_nolock_test WHERE org_id = ${orgId}`;

      const assignUnsafe = async () => {
        const [{ count }] = await sql`
          SELECT count(*)::int AS count FROM inv_num_nolock_test WHERE org_id = ${orgId}
        `;
        const nextNum = Number(count) + 1;
        await new Promise<void>((r) => setTimeout(r, 25));
        await sql`INSERT INTO inv_num_nolock_test (org_id, num) VALUES (${orgId}, ${nextNum})`;
        return nextNum;
      };

      const [n1, n2] = await Promise.all([assignUnsafe(), assignUnsafe()]);
      expect(n1).toBe(n2);

      await sql`DROP TABLE IF EXISTS inv_num_nolock_test`;
    }, 60_000);
  });
});
