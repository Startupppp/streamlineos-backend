/**
 * HRMS-E2E-003, against a real Postgres.
 *
 * QA imported five employee rows into QA Audit Co, the job reported
 * "Committed, Valid 5, Errors 0", and the employee directory stayed at two
 * people. Both statements were true. The old commit path wrote
 * `organization_people`, `hr_people` and `hr_employments` and stopped — but the
 * directory reads FROM organization_members INNER JOIN users and only LEFT JOINs
 * hr_people (`employees.service.ts:156`), so a row with no user account and no
 * membership could never be listed. It also left `hr_people.user_id` NULL, which
 * is what made the leave-balance, attendance and document imports fail for those
 * same people with "No user found for email".
 *
 * These assertions are about rows in real tables, in the joins the directory
 * uses. The mock suite that used to stand here asserted the opposite — that an
 * `hr_people` insert was enough — and so agreed with the defect.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="hr-employee-import"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { HrImportCommitService } from "./hr-import-commit.service";
import type { CommitOutcome } from "./hr-import-commit.service";
import { MembershipAdmissionService } from "../../organization/core/membership-admission.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { importContext } from "./import-commit-test-harness";

const describeDb = dbSpecSuite();

const SHEET = [
  {
    email: "qa-set1-0924@example.com",
    firstName: "QA",
    lastName: "SettingsImportOne",
    joiningDate: "2026-09-02",
    designation: "QA Analyst",
    employeeNumber: "EMP-QS01",
  },
  {
    email: "qa-set2-0924@example.com",
    firstName: "QA",
    lastName: "SettingsImportTwo",
    joiningDate: "2026-09-02",
    designation: "QA Analyst",
    employeeNumber: "EMP-QS02",
  },
];

describeDb("employee import reaches the directory — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "hr-employee-import.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: HrImportCommitService;
  const orgId = `qa-emp-import-${randomUUID()}`;
  const ownerId = `qa-owner-${randomUUID()}`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });

    // The real services, not doubles: the point of this suite is that the import
    // now goes through the same admission and person-employment code the
    // single-hire form uses, and a double could not show that.
    const audit = { log: async () => undefined, logMany: async () => undefined };
    const personEmployment = new PersonEmploymentSyncService(db, audit as never);
    // Seat accounting and plan limits are the two things admission reaches for.
    // A local verification database has no plan attached, so the limit check is
    // satisfied and the seat events are recorded into a collector this suite can
    // assert on — the admission code itself is the real thing.
    const seatEvents: unknown[] = [];
    const admission = new MembershipAdmissionService(
      { assertWithinLimit: async () => undefined } as never,
      { recordSeatEvents: async (...args: unknown[]) => void seatEvents.push(args) } as never,
    );
    service = new HrImportCommitService(admission, personEmployment);

    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${ownerId}, ${`${ownerId}@example.com`}, ${"QA Owner"})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Employee Import Co"}, ${orgId}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${orgId}, ${ownerId}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)
      `;
    });
  });

  afterAll(async () => {
    if (!sql) return;
    const emails = SHEET.map((row) => row.email);
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where email = any(${emails}) or id = ${ownerId}`;
    await sql.end({ timeout: 5 });
  });

  async function importSheet(rows: ReadonlyArray<Record<string, unknown>>): Promise<CommitOutcome[]> {
    return db.transaction(async (tx) => {
      const outcomes: CommitOutcome[] = [];
      for (const row of rows) {
        const ref = await service.commitRow(tx, importContext(orgId, ownerId), "employees", row);
        if (ref) outcomes.push(ref.outcome);
      }
      return outcomes;
    });
  }

  /** Exactly the join the employee directory lists from. */
  const directoryCount = async (): Promise<number> =>
    Number(
      (
        await sql`
          select count(*)::int as n
          from organization_members m
          join users u on u.id = m.user_id
          where m.org_id = ${orgId} and m.status = 'ACTIVE'
        `
      )[0]?.n ?? -1,
    );

  it("puts an imported employee where the directory can see them", async () => {
    // The owner is the only member before the import.
    expect(await directoryCount()).toBe(1);

    const outcomes = await importSheet(SHEET);
    expect(outcomes).toEqual(["created", "created"]);
    expect(await directoryCount()).toBe(1 + SHEET.length);
  });

  it("links hr_people to the user, which is what every other import resolves", async () => {
    const rows = await sql`
      select p.user_id, op.work_email
      from hr_people p
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where p.org_id = ${orgId}
      order by op.work_email
    `;
    expect(rows).toHaveLength(SHEET.length);
    for (const row of rows) expect(row.user_id).toEqual(expect.any(String));
  });

  it("records the employment the sheet describes", async () => {
    const [row] = await sql`
      select e.employee_number, e.designation, e.joining_date::text as joining_date
      from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where e.org_id = ${orgId} and op.work_email = ${SHEET[0].email}
    `;
    expect(row?.employee_number).toBe("EMP-QS01");
    expect(row?.designation).toBe("QA Analyst");
    expect(row?.joining_date).toBe("2026-09-02");
  });

  it("re-imports as updates, not as a second set of employees", async () => {
    const before = await directoryCount();
    const outcomes = await importSheet(SHEET);
    expect(outcomes).toEqual(["updated", "updated"]);
    expect(await directoryCount()).toBe(before);
  });

  it("applies a corrected designation on re-import instead of silently ignoring it", async () => {
    await importSheet([{ ...SHEET[0], designation: "QA Senior Test Engineer" }]);

    const [row] = await sql`
      select e.designation
      from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where e.org_id = ${orgId} and op.work_email = ${SHEET[0].email}
    `;
    expect(row?.designation).toBe("QA Senior Test Engineer");
  });

  it("refuses an employee number that already belongs to somebody else", async () => {
    await expect(
      importSheet([{ ...SHEET[1], employeeNumber: "EMP-QS01" }]),
    ).rejects.toThrow(/already belongs to someone else/i);
  });
});
