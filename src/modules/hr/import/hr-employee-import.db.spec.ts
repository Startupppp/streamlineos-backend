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
import { ReportingLineService } from "../../directory/reporting-line.service";
import { ReportingManagerPolicyService } from "../../directory/reporting-manager-policy.service";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { HrImportCommitService } from "./hr-import-commit.service";
import type { CommitOutcome } from "./hr-import-commit.service";
import { MembershipAdmissionService } from "../../organization/core/membership-admission.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { withMembershipMutations } from "../../../common/org/membership-mutations";

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

const ROLLBACK_ROW = {
  email: "qa-rollback-0926@example.com",
  firstName: "QA",
  lastName: "Rollback",
  joiningDate: "2026-09-02",
  designation: "QA Analyst",
  employeeNumber: "EMP-QRB1",
  topLevelRoleReason: "Rollback probe",
};

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
    const access = {
      holds: async () => true,
      resolveUserPermissions: async () => new Map(),
    };
    const reportingLines = new ReportingLineService(db);
    const policies = new ReportingManagerPolicyService(db, access as never, reportingLines, { logCritical: async () => undefined } as never);
    service = new HrImportCommitService(
      admission,
      personEmployment,
      new ReportingRelationshipService(
        db,
        reportingLines,
        policies,
        { logCritical: async () => undefined } as never,
        { invalidateAfterMutation: async () => undefined } as never,
        { invalidateNamespace: async () => undefined } as never,
      ),
    );

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
    const emails = [...SHEET.map((row) => row.email), ROLLBACK_ROW.email];
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where email = any(${emails}) or id = ${ownerId}`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  /**
   * The real membership writer, through the real wrapper — the same call shape
   * `commitJob` uses. Only the cache it drains into is a collector: the drain
   * runs after the transaction resolves and publishes nothing this suite reads.
   */
  async function importSheet(rows: ReadonlyArray<Record<string, unknown>>): Promise<CommitOutcome[]> {
    const noop = async (): Promise<undefined> => undefined;
    const cache = {
      invalidateMany: noop,
      invalidateNamespaceMany: noop,
      invalidateNamespace: noop,
      invalidateNamespaceForOrg: noop,
      del: noop,
    };
    return withMembershipMutations(cache as never, (membership) =>
      db.transaction(async (tx) => {
        const outcomes: CommitOutcome[] = [];
        for (const row of rows) {
          const ref = await service.commitRow(
            tx,
            { orgId, actorId: ownerId, membership, actor: { orgId, userId: ownerId, isOrgOwner: true } },
            "employees",
            row,
          );
          if (ref) outcomes.push(ref.outcome);
        }
        return outcomes;
      }),
    );
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

  /**
   * V-010. `departmentName` is advertised as a template column and
   * `departmentId` is accepted by the schema, but `commitEmployee` read
   * neither: the cell parsed, validated, and was thrown away, so every
   * imported employee landed with no department and the org chart and the
   * department filters stayed empty. These assertions are on
   * `hr_employments.department_id` because that is the column the drop was in.
   */
  describe("the department the sheet names", () => {
    const unitId = `qa-unit-${randomUUID()}`;

    beforeAll(async () => {
      await sql`
        insert into org_units (id, org_id, kind, name, code)
        values (${unitId}, ${orgId}, ${"DEPARTMENT"}, ${"QA Engineering"}, ${`QAENG-${unitId.slice(-8)}`})
      `;
    });

    const departmentOf = async (email: string): Promise<string | null> => {
      const [row] = await sql`
        select e.department_id
        from hr_employments e
        join hr_people p on p.id = e.person_id and p.org_id = e.org_id
        join organization_people op
          on op.organization_id = p.org_id
         and op.organization_person_id = p.organization_person_id
        where e.org_id = ${orgId} and op.work_email = ${email}
      `;
      return (row?.department_id as string | null) ?? null;
    };

    it("writes the department a name resolves to", async () => {
      expect(await departmentOf(SHEET[0].email)).toBeNull();
      await importSheet([{ ...SHEET[0], departmentName: "qa engineering" }]);
      // Matched case-insensitively on the trimmed name, which is how an
      // operator types it into a spreadsheet.
      expect(await departmentOf(SHEET[0].email)).toBe(unitId);
    });

    it("refuses a department name no unit in this org carries", async () => {
      await expect(
        importSheet([{ ...SHEET[1], departmentName: "Astrophysics" }]),
      ).rejects.toThrow(/Department "Astrophysics" was not found/);
      // The row must not land with a NULL department reported as imported.
      expect(await departmentOf(SHEET[1].email)).toBeNull();
    });
  });

  /**
   * V-010, second half. `managerEmail` had the same fate as `departmentName`.
   * HRM-15: the column is now `primaryManagerEmail` and the line is written by
   * the canonical relationship service, which only accepts a manager who has
   * accepted their invitation — so the manager is marked accepted first.
   */
  it("opens a reporting line for the manager the sheet names", async () => {
    await sql`
      update users set email_verified = now()
      where id in (select user_id from organization_members where org_id = ${orgId})
    `;
    const [manager] = await sql`
      select e.id
      from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where e.org_id = ${orgId} and op.work_email = ${SHEET[1].email}
    `;
    const managerEmploymentId = Number(manager?.id);

    await importSheet([
      {
        ...SHEET[0],
        primaryManagerEmail: SHEET[1].email,
      },
    ]);

    const lines = await sql`
      select l.manager_employment_id, l.line_type, l.effective_to::text as effective_to
      from hr_reporting_lines l
      join hr_employments e on e.id = l.employment_id and e.org_id = l.org_id
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where l.org_id = ${orgId} and op.work_email = ${SHEET[0].email}
    `;
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]?.manager_employment_id)).toBe(managerEmploymentId);
    expect(lines[0]?.line_type).toBe("primary");
    expect(lines[0]?.effective_to).toBe("infinity");

    // Re-importing the same manager is a no-op, not a second overlapping line
    // (the exclusion constraint would refuse one anyway — this asserts the
    // importer does not even try).
    await importSheet([
      {
        ...SHEET[0],
        primaryManagerEmail: SHEET[1].email,
      },
    ]);
    const [again] = await sql`
      select count(*)::int as n from hr_reporting_lines where org_id = ${orgId}
    `;
    expect(Number(again?.n)).toBe(1);
  });

  it("refuses a manager that would close a reporting cycle", async () => {
    const [self] = await sql`
      select e.id
      from hr_employments e
      join hr_people p on p.id = e.person_id and p.org_id = e.org_id
      join organization_people op
        on op.organization_id = p.org_id
       and op.organization_person_id = p.organization_person_id
      where e.org_id = ${orgId} and op.work_email = ${SHEET[0].email}
    `;
    // SHEET[0] already reports to SHEET[1]; pointing SHEET[1] back at SHEET[0]
    // closes the loop every manager-chain read then walks.
    await expect(
      importSheet([
        {
          ...SHEET[1],
          primaryManagerEmail: SHEET[0].email,
        },
      ]),
    ).rejects.toThrow(/PRIMARY_CYCLE/);
    expect(self?.id).toBeDefined();
  });

  /**
   * HRM-15 addendum 2. A job rollback deleted `hr_people` alone, and every imported person has an
   * employment behind `fk_hr_employments_org_person ON DELETE RESTRICT`, so the rollback failed with
   * 23503 and the whole job 500'd. The employment goes first now; its lines and top-level role cascade.
   */
  it("rolls back an employee the job created, employment and top-level role included", async () => {
    const noop = async (): Promise<undefined> => undefined;
    const cache = { invalidate: noop, invalidateMany: noop, invalidateNamespaceMany: noop, invalidateNamespace: noop, invalidateNamespaceForOrg: noop, del: noop };
    const ref = await withMembershipMutations(cache as never, (membership) =>
      db.transaction((tx) =>
        service.commitRow(tx, { orgId, actorId: ownerId, membership, actor: { orgId, userId: ownerId, isOrgOwner: true } }, "employees", ROLLBACK_ROW),
      ),
    );
    expect(ref?.outcome).toBe("created");
    const [before] = await sql`select count(*)::int as n from hr_top_level_roles where org_id = ${orgId}`;
    expect(Number(before?.n)).toBeGreaterThan(0);

    await db.transaction((tx) => service.rollbackRef(tx, { table: "hr_people", id: Number(ref?.id), outcome: "created" }));

    const [people] = await sql`select count(*)::int as n from hr_people where org_id = ${orgId} and id = ${Number(ref?.id)}`;
    const [employments] = await sql`select count(*)::int as n from hr_employments where org_id = ${orgId} and person_id = ${Number(ref?.id)}`;
    expect(Number(people?.n)).toBe(0);
    expect(Number(employments?.n)).toBe(0);
  });
});
