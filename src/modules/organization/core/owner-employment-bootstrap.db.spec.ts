/**
 * HRMS-E2E-002a / 008b / HRMS-LEGACY-02, against a real Postgres.
 *
 * An organisation used to be created without an employment record for the
 * person who created it. Three QA findings are that one absence:
 *
 *   - a bulk onboarding sheet naming the owner as `reportingManagerEmail` failed
 *     every dependent row with "manager has no employment record";
 *   - `ApprovalAuthorityService.consider` skipped the owner with
 *     `manager-has-no-employment`, so a one-person org had no leave approver at
 *     all and the submit button was permanently disabled;
 *   - the owner exported from the directory with empty employment columns.
 *
 * These assertions exercise `ensureManyFromUsers` — the same idempotent path the
 * org bootstrap, the single-hire form and the backfill all use — against real
 * tables, because the defect was that no row existed, which no mock can show.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="owner-employment-bootstrap"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { ensureManyFromUsers } from "../../hr/core/person-employment-sync-batch";
import { toEnsureInput } from "../../hr/core/person-employment-sync.types";

const describeDb = dbSpecSuite();

describeDb("owner employment at organisation creation — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "owner-employment-bootstrap.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const orgId = `qa-owner-emp-${randomUUID()}`;
  const ownerId = `qa-founder-${randomUUID()}`;
  const ownerEmail = `${ownerId}@example.com`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, email, name, first_name, last_name)
        values (${ownerId}, ${ownerEmail}, ${"Asha Verma"}, ${"Asha"}, ${"Verma"})
      `;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Founder Co"}, ${orgId}, ${membershipId})
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

  /** What `bootstrapCellOrganization` now runs for the founder. */
  async function provisionOwner(): Promise<void> {
    await db.transaction(async (tx) => {
      await ensureManyFromUsers(tx, orgId, [
        toEnsureInput(
          {
            userId: ownerId,
            email: ownerEmail,
            name: "Asha Verma",
            firstName: "Asha",
            lastName: "Verma",
            phone: null,
          },
          "PRE_JOINING",
        ),
      ]);
    });
  }

  const employmentRow = async (): Promise<Record<string, unknown> | undefined> => {
    const rows = await sql`
      select e.id, e.employee_number, e.lifecycle_status, p.user_id
      from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      where e.org_id = ${orgId} and p.user_id = ${ownerId}
    `;
    return rows[0];
  };

  it("gives the founder an employment record", async () => {
    expect(await employmentRow()).toBeUndefined();
    await provisionOwner();

    const row = await employmentRow();
    expect(row).toBeDefined();
    expect(row?.employee_number).toEqual(expect.any(String));
  });

  it("stages the founder rather than counting them as a hire", async () => {
    // PRE_JOINING keeps a founder who was never hired out of headcount and
    // attrition while still making them addressable as a person at work.
    expect((await employmentRow())?.lifecycle_status).toBe("PRE_JOINING");
  });

  it("links the employment to a canonical person carrying the owner's email", async () => {
    const [row] = await sql`
      select op.work_email, op.first_name, op.last_name
      from hr_people p
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where p.org_id = ${orgId} and p.user_id = ${ownerId}
    `;
    expect(row?.work_email).toBe(ownerEmail);
    // The name is taken as entered — no title-casing (HRMS-E2E-020).
    expect(row?.first_name).toBe("Asha");
    expect(row?.last_name).toBe("Verma");
  });

  it("is idempotent, so a backfill over an existing org adds nothing", async () => {
    const before = await employmentRow();
    await provisionOwner();
    await provisionOwner();

    const rows = await sql`
      select e.id from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      where e.org_id = ${orgId} and p.user_id = ${ownerId}
    `;
    expect(rows).toHaveLength(1);
    expect((await employmentRow())?.id).toBe(before?.id);
  });
});
