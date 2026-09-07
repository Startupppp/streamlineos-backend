/**
 * Real-database regression for the analytics-plus department filter.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
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
import type { Db } from "../../../../db/drizzle.types";
import { fetchLeaveTrends, fetchComplianceGaps } from "../hr-analytics-plus-trends";
import { fetchDrilldownPage } from "../hr-analytics-plus-drilldown";
import { departmentMemberFilter } from "../hr-analytics-plus-department-filter";

/**
 * The seeded reference tenant, not the `kbprobe-a` this file used to name. That org is created
 * by no seeder here, so every query below ran against an organisation with no rows — and the
 * assertions are "the call resolves" and "the filtered page is empty", both of which an EMPTY
 * ORG satisfies for free. The suite reported green while proving nothing about the filter it
 * exists to pin. See `test/helpers/probe-org.ts` for the same defect in its other two specs.
 */
const ORG_ID = process.env.SEED_ORG_ID ?? "aaaaaaaa-1111-0000-0000-000000000001";
const DEPARTMENT_ID = "dept-does-not-exist";

const METRICS = ["attrition", "leave", "attendance", "cases"] as const;

/**
 * How many of the four metrics must carry rows before the filter assertions mean anything.
 * A floor rather than a per-metric requirement: `attrition` and `cases` have no seeded rows
 * today, and failing on that would be reporting a seed gap as a filter regression. The floor
 * still refuses the state this file was actually in, where the count was zero.
 */
const MIN_COVERED_METRICS = 2;

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("hr-analytics-plus-department-filter.db.spec.ts requires DATABASE_URL or APP_DATABASE_URL");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describe("hr analytics-plus department filter — real database", () => {
  let sql_: ReturnType<typeof connect>;
  let db: Db;

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

  it("the fixture org carries drilldown rows, so the assertions below can fail", async () => {
    const totals = await Promise.all(
      METRICS.map(async (metric) => ({
        metric,
        total: (await fetchDrilldownPage(db, ORG_ID, metric, 1, 20)).total,
      })),
    );
    // Asserted on the breakdown rather than on a bare count so a failure names WHICH metrics
    // are empty — the number alone sends the reader looking for a filter regression that is
    // really a seed gap.
    const byMetric = Object.fromEntries(totals.map((entry) => [entry.metric, entry.total]));
    const covered = totals.filter((entry) => entry.total > 0).map((entry) => entry.metric);
    expect({ byMetric, covered: covered.length >= MIN_COVERED_METRICS }).toEqual({
      byMetric,
      covered: true,
    });
  }, 60_000);

  it.each(METRICS)(
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

      // The narrowing is only demonstrated where there was something to narrow. Asserting it
      // unconditionally would turn "this metric has no seeded rows" into "the filter regressed",
      // which sends the next reader to the wrong file.
      if (unfiltered.total > 0) expect(filtered.total).toBeLessThan(unfiltered.total);
    },
    60_000,
  );

  it("an unknown metric returns an empty page rather than throwing", async () => {
    const result = await fetchDrilldownPage(db, ORG_ID, "nonsense", 1, 20, DEPARTMENT_ID);
    expect(result).toMatchObject({ rows: [], total: 0 });
  });
});
