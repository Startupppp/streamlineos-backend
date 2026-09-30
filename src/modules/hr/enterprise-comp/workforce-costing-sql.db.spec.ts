/**
 * The costing and emergency-broadcast queries, executed against a real Postgres.
 *
 * Both of the queries exercised here were raw `sql` templates joining
 * `hr_employments` on a `user_id` column that table does not have. Postgres
 * answered 42703 "column he.user_id does not exist" on every call, so
 * `GET /hr/enterprise/comp/costing/by-location` and a location-scoped
 * `POST /hr/emergency/:id/broadcast` could never return a row. Nothing caught
 * it: raw SQL is opaque to `tsc`, and the unit suites for both services stub
 * `db.execute`, so the assertion that a mock is called with a template says
 * nothing about whether Postgres will accept it. A defect that lives in the SQL
 * string can only be found by sending the string to a database.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/qa_local ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="workforce-costing-sql"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { WorkforceCostingService } from "./workforce-costing.service";

const describeDb = dbSpecSuite();

describeDb("workforce costing SQL — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "workforce-costing-sql.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let service: WorkforceCostingService;

  const orgId = `qa-costing-${randomUUID()}`;
  const engineerId = `qa-eng-${randomUUID()}`;
  const contractorId = `qa-con-${randomUUID()}`;
  const locationId = `qa-loc-${randomUUID()}`;
  const deptId = `qa-dept-${randomUUID()}`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    const db = drizzle(sql, { schema });
    service = new WorkforceCostingService(db as never);

    await sql.begin(async (tx) => {
      for (const id of [engineerId, contractorId]) {
        await tx`insert into users (id, email, name) values (${id}, ${`${id}@example.com`}, ${"QA Person"})`;
      }
      const [seq] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const ownerMembership = Number(seq?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Costing Co"}, ${orgId}, ${ownerMembership})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${ownerMembership}, ${orgId}, ${engineerId}, ${"OWNER"}, ${"ACTIVE"}, true)
      `;
      const [seq2] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const secondMembership = Number(seq2?.id);
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${secondMembership}, ${orgId}, ${contractorId}, ${"MEMBER"}, ${"ACTIVE"}, false)
      `;

      await tx`
        insert into org_units (id, org_id, kind, name, code, status)
        values (${deptId}, ${orgId}, ${"DEPARTMENT"}, ${"Engineering"}, ${"ENG"}, ${"ACTIVE"}),
               (${locationId}, ${orgId}, ${"LOCATION"}, ${"Hyderabad"}, ${"HYD"}, ${"ACTIVE"})
      `;
      await tx`
        insert into org_unit_members (id, org_id, org_unit_id, role, membership_id)
        values (${`${deptId}-m`}, ${orgId}, ${deptId}, ${"MEMBER"}, ${ownerMembership})
      `;

      /**
       * Only the engineer gets an employment row, and it carries a location.
       * The contractor deliberately has none, which is what makes the
       * by-location breakdown's inner join observable.
       */
      const [person] = await tx<{ id: number }[]>`
        insert into hr_people (org_id, user_id) values (${orgId}, ${engineerId}) returning id
      `;
      await tx`
        insert into hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, location_id)
        values (${orgId}, ${person!.id}, ${`QA-${person!.id}`}, ${"ACTIVE"}, true, ${locationId})
      `;

      // ₹12,00,000 and ₹6,00,000 per year, both current.
      await tx`
        insert into employee_salary_profiles (org_id, user_id, annual_ctc, status, effective_from)
        values (${orgId}, ${engineerId}, ${"1200000.00"}, ${"ACTIVE"}, ${"2020-01-01"}),
               (${orgId}, ${contractorId}, ${"600000.00"}, ${"ACTIVE"}, ${"2020-01-01"})
      `;
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from employee_salary_profiles where org_id = ${orgId}`;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id in (${engineerId}, ${contractorId})`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  it("answers the by-location breakdown instead of raising 42703", async () => {
    // The load-bearing assertion. Before the join was repaired this threw
    // `column he.user_id does not exist`, which is the 500 the page turned into
    // "Failed to load the HR module".
    const rows = await service.costByLocation(orgId);
    expect(rows).toEqual([
      { locationId, headcount: 1, monthlyCostCents: 10_000_000 },
    ]);
  });

  it("reports the headline in cents, not in rupees", async () => {
    // BUG-017's scale fix, executed rather than mocked: 12,00,000 + 6,00,000
    // rupees is 18,00,00,000 paise, and a twelfth of that per month.
    expect(await service.costSummary(orgId)).toEqual({
      totalHeadcount: 2,
      totalAnnualCtcCents: 180_000_000,
      totalMonthlyCostCents: 15_000_000,
    });
  });

  it("answers the by-department breakdown", async () => {
    expect(await service.costByDepartment(orgId, "2026-09")).toEqual([
      { departmentId: deptId, departmentName: "Engineering", headcount: 1, monthlyCostCents: 10_000_000 },
    ]);
  });

  it("returns zeros rather than NaN for an organisation with no salary profiles", async () => {
    // SUM() over no rows is NULL in Postgres, not 0 — the mapper's `?? 0` is
    // what keeps that off the page, and only a real database produces the NULL.
    expect(await service.costSummary(`qa-empty-${randomUUID()}`)).toEqual({
      totalHeadcount: 0,
      totalAnnualCtcCents: 0,
      totalMonthlyCostCents: 0,
    });
  });

  it("counts a person with a second employment row once", async () => {
    // Without `is_primary`, a duplicate employment row doubles that person's
    // salary in the location total — a money defect, not a headcount one.
    const [person] = await sql<{ id: number }[]>`
      select id from hr_people where org_id = ${orgId} and user_id = ${engineerId}
    `;
    const [extra] = await sql<{ id: number }[]>`
      insert into hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, location_id)
      values (${orgId}, ${person!.id}, ${`QA-extra-${person!.id}`}, ${"ACTIVE"}, false, ${locationId})
      returning id
    `;
    try {
      expect(await service.costByLocation(orgId)).toEqual([
        { locationId, headcount: 1, monthlyCostCents: 10_000_000 },
      ]);
    } finally {
      await sql`delete from hr_employments where id = ${extra!.id}`;
    }
  });

  it("reaches employees by location for an emergency broadcast", async () => {
    /**
     * `EmergencyService.broadcast` carried the identical broken join, so this
     * asserts the repaired shape of that query directly against the database.
     */
    const rows = await sql<{ id: string }[]>`
      SELECT DISTINCT u.id FROM users u
      INNER JOIN organization_members om ON om.user_id = u.id AND om.org_id = ${orgId}
      INNER JOIN hr_people hp ON hp.org_id = ${orgId} AND hp.user_id = u.id AND hp.deleted_at IS NULL
      INNER JOIN hr_employments he ON he.org_id = ${orgId} AND he.person_id = hp.id
        AND he.location_id = ${locationId} AND he.deleted_at IS NULL
    `;
    expect(rows.map((row) => row.id)).toEqual([engineerId]);
  });
});
