/**
 * Real-database regression for the analytics-plus department filter.
 *
 * Guarded by HR_DB_TESTS=1. Run with:
 *   HR_DB_TESTS=1 DATABASE_URL=... npx jest --runInBand \
 *     --testPathPattern="hr-analytics-plus-department-filter.db"
 *
 * /leave-trends, /compliance-gaps and /drilldown all accepted a departmentId,
 * all keyed their cache on it, and none of them applied it — so filtering to one
 * department returned the whole organisation under a per-department cache key,
 * which made the wrong answer look like a distinct one.
 *
 * These run against a real Postgres because the filter is SQL: the point is
 * that every one of these statements parses and executes against the live
 * catalog, that the page query and its COUNT carry the same predicate, and that
 * the semi-join does not multiply rows the way an added JOIN would.
 */
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import { fetchLeaveTrends, fetchComplianceGaps } from "../hr-analytics-plus-trends";
import { fetchDrilldownPage } from "../hr-analytics-plus-drilldown";
import { departmentMemberFilter } from "../hr-analytics-plus-department-filter";

const ENABLED = process.env.HR_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const ORG_ID = "kbprobe-a";
const DEPARTMENT_ID = "dept-does-not-exist";

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for HR_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describeDb("hr analytics-plus department filter — real database", () => {
  let sql_: ReturnType<typeof connect>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sql_ = connect();
    db = drizzle(sql_, { schema });
  });

  afterAll(async () => {
    if (sql_) await sql_.end({ timeout: 5 });
  });

  it("builds no predicate when no department is requested", () => {
    expect(departmentMemberFilter(ORG_ID, undefined, sql`lr.user_id`).queryChunks).toHaveLength(0);
  });

  it("leave trends executes with and without a department", async () => {
    await expect(fetchLeaveTrends(db, ORG_ID)).resolves.toBeDefined();
    await expect(fetchLeaveTrends(db, ORG_ID, DEPARTMENT_ID)).resolves.toBeDefined();
  });

  it("compliance gaps executes with and without a department", async () => {
    await expect(fetchComplianceGaps(db, ORG_ID)).resolves.toBeDefined();
    await expect(fetchComplianceGaps(db, ORG_ID, DEPARTMENT_ID)).resolves.toBeDefined();
  });

  it.each(["attrition", "leave", "attendance", "cases"])(
    "the %s drilldown applies the department to both the page and its count",
    async (metric) => {
      const unfiltered = await fetchDrilldownPage(db, ORG_ID, metric, 1, 20);
      expect(unfiltered.rows.length).toBeLessThanOrEqual(unfiltered.total);

      // No employment sits in this department, so a filter that is genuinely
      // applied must empty the page AND the total. Before the fix both came
      // back with the whole organisation's rows.
      const filtered = await fetchDrilldownPage(db, ORG_ID, metric, 1, 20, DEPARTMENT_ID);
      expect(filtered.rows).toHaveLength(0);
      expect(filtered.total).toBe(0);
    },
  );

  it("an unknown metric returns an empty page rather than throwing", async () => {
    const result = await fetchDrilldownPage(db, ORG_ID, "nonsense", 1, 20, DEPARTMENT_ID);
    expect(result).toMatchObject({ rows: [], total: 0 });
  });
});
