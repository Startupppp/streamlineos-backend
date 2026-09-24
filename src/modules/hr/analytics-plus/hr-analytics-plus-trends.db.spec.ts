/**
 * HRMS-E2E-011, against a real Postgres.
 *
 * `GET /hr/analytics-plus/engagement` answered 500 on every call. The ticket
 * reads like a null-safety problem — "hard-errors on an empty tenant" — but the
 * query never ran at all: `hr_mood_checkins.date` is a text column holding
 * YYYY-MM-DD, and the predicate compared it to `NOW() - INTERVAL '12 months'`.
 * Postgres has no `text >= timestamptz` operator, so it raised 42883 before
 * looking at a single row. Seeding the table would not have helped.
 *
 * Only a real database can show that: the SQL is a `db.execute` template, so it
 * typechecks, passes every static gate, and fails the moment Postgres parses it.
 * These assertions run each analytics trend query against real tables — the
 * empty-tenant case and the populated one — and fail if the cast is removed.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="hr-analytics-plus-trends"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import {
  fetchEngagementTrends,
  fetchPayrollCost,
  fetchPerformanceDistribution,
  fetchComplianceGaps,
} from "./hr-analytics-plus-trends";

const describeDb = dbSpecSuite();

describeDb("HR analytics trends — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "hr-analytics-plus-trends.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const orgId = `qa-analytics-${randomUUID()}`;
  const userId = `qa-analytics-user-${randomUUID()}`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${userId}, ${`${userId}@example.com`}, ${"QA Analytics"})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Analytics Co"}, ${orgId}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${orgId}, ${userId}, ${"OWNER"}, ${"ACTIVE"}, true)
      `;
    });
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id in (${userId}, ${`${userId}-2`})`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  it("answers an empty tenant with an empty series instead of raising", async () => {
    await expect(fetchEngagementTrends(db, orgId)).resolves.toEqual({ moodByMonth: [] });
  });

  it("reads mood check-ins whose date column is text", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // uniq_mood_org_user_date allows one check-in per person per day, so the
    // average is taken across two people rather than two rows for one.
    // A trigger refuses a check-in whose actor is not a member of the org, so
    // the second person is admitted before their mood is recorded.
    const second = `${userId}-2`;
    await sql`insert into users (id, email, name) values (${second}, ${`${second}@example.com`}, ${"QA Analytics Two"})`;
    await sql`
      insert into organization_members (org_id, user_id, role, status)
      values (${orgId}, ${second}, ${"MEMBER"}, ${"ACTIVE"})
    `;
    await sql`
      insert into hr_mood_checkins (org_id, user_id, date, mood)
      values (${orgId}, ${userId}, ${today}, 4), (${orgId}, ${second}, ${today}, 2)
    `;

    const result = await fetchEngagementTrends(db, orgId);
    expect(result.moodByMonth).toHaveLength(1);
    expect(result.moodByMonth[0]?.month).toBe(today.slice(0, 7));
    expect(result.moodByMonth[0]?.avgMood).toBe(3);
  });

  it("leaves a check-in older than the window out of the series", async () => {
    await sql`
      insert into hr_mood_checkins (org_id, user_id, date, mood)
      values (${orgId}, ${userId}, ${"2019-01-15"}, 5)
    `;
    const result = await fetchEngagementTrends(db, orgId);
    expect(result.moodByMonth.map((entry) => entry.month)).not.toContain("2019-01");
  });

  it.each([
    ["payroll cost", (id: string) => fetchPayrollCost(db, id)],
    ["performance distribution", (id: string) => fetchPerformanceDistribution(db, id)],
    ["compliance gaps", (id: string) => fetchComplianceGaps(db, id)],
  ])("%s answers an empty tenant without raising", async (_label, run) => {
    await expect(run(orgId)).resolves.toBeDefined();
  });
});
