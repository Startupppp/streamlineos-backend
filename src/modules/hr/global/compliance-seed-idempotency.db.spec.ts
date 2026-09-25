/**
 * HRMS-LEGACY-06, against a real Postgres: seeding a country pack is idempotent,
 * including when two requests race (a double-click on "Apply India pack").
 *
 * `seedCountryPack` reads what already exists and inserts the rest. Two
 * concurrent calls both read "nothing yet" and both insert. Requirements then
 * collide on `uniq_hr_compliance_req_org_name`, so one request fails with a
 * 500. Holidays have no unique index at all, so every public holiday is
 * written twice. Only a real database shows either.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --config ./jest-db.json --testPathPattern="compliance-seed-idempotency"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { HrAuditService } from "../core/hr-audit.service";
import { ComplianceRequirementsService } from "./compliance-requirements.service";
import { COUNTRY_PACKS } from "./country-packs";

const describeDb = dbSpecSuite();

describeDb("country pack seed — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "compliance-seed-idempotency.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let service: ComplianceRequirementsService;
  const orgId = `qa-pack-${randomUUID()}`;
  const ownerId = `qa-pack-owner-${randomUUID()}`;
  const india = COUNTRY_PACKS["IN"];
  const year = 2031;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 8 });
    const db = drizzle(sql, { schema });
    service = new ComplianceRequirementsService(db, new HrAuditService(db));
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${ownerId}, ${`${ownerId}@example.com`}, ${"Pack Owner"})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Pack Co"}, ${orgId}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${orgId}, ${ownerId}, ${"OWNER"}, ${"ACTIVE"}, true)
      `;
    });
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id = ${ownerId}`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  async function counts() {
    const [requirements] = await sql`
      select count(*)::int as n from hr_compliance_requirements where org_id = ${orgId}`;
    const [duplicateHolidays] = await sql`
      select count(*)::int as n from (
        select date, name from holidays where org_id = ${orgId} group by date, name having count(*) > 1
      ) d`;
    const [holidayRows] = await sql`select count(*)::int as n from holidays where org_id = ${orgId}`;
    return {
      requirements: Number(requirements?.n),
      duplicateHolidays: Number(duplicateHolidays?.n),
      holidays: Number(holidayRows?.n),
    };
  }

  it("the India pack exists and is not empty, so the assertions below are not vacuous", () => {
    expect(india?.complianceRequirements.length).toBeGreaterThan(0);
    expect(india?.defaultHolidays.length).toBeGreaterThan(0);
  });

  it("five concurrent seeds all succeed and write each requirement and holiday exactly once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.seedCountryPack(orgId, ownerId, { country: "IN", year })),
    );

    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    );
    expect(failures).toEqual([]);

    const after = await counts();
    expect(after.requirements).toBe(india?.complianceRequirements.length);
    // Two India holidays share 10-02 (Gandhi Jayanti, Dussehra); both belong.
    expect(after.holidays).toBe(india?.defaultHolidays.length);
    expect(after.duplicateHolidays).toBe(0);

    // The reported numbers add up to what was actually written, not 5x it.
    const reported = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    expect(reported.reduce((sum, r) => sum + r.requirements, 0)).toBe(after.requirements);
    expect(reported.reduce((sum, r) => sum + r.holidays, 0)).toBe(after.holidays);
  }, 30_000);

  it("a sequential re-run writes nothing and says so", async () => {
    const before = await counts();
    const rerun = await service.seedCountryPack(orgId, ownerId, { country: "IN", year });

    expect(rerun.requirements).toBe(0);
    expect(rerun.holidays).toBe(0);
    expect(await counts()).toEqual(before);
  }, 30_000);
});
