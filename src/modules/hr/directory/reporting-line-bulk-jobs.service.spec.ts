import { makeCountingDb } from "../../../db/__tests__/counting-db";
import type { Db, TenantTx } from "../../../db/drizzle.types";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { RelationshipValidation } from "../../directory/reporting-line.types";
import { ReportingLineBulkJobsService, classifyBulkRow, rejectFileCycles, type PlannedRow } from "./reporting-line-bulk-jobs.service";

const ORG = "org-bulk-jobs";
const ACTOR: CurrentUserContext = {
  orgId: ORG,
  userId: "hr-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: ACCOUNT_ONLY_PRINCIPAL,
};

function person(index: number) {
  return {
    userId: `user-${index}`,
    name: `Person ${index}`,
    email: `p${index}@example.com`,
    designation: null,
    employmentId: 1000 + index,
    lifecycleStatus: "ACTIVE",
    userActive: true,
    membershipStatus: "ACTIVE",
  };
}

function validation(overrides: Partial<RelationshipValidation> = {}): RelationshipValidation {
  return {
    ok: true,
    issues: [],
    warnings: [],
    employmentId: 1,
    currentPrimaryManagerEmploymentId: 2,
    primaryManagerEmploymentId: 999,
    primaryChanged: true,
    primaryChangesLast24h: 0,
    requiresReason: false,
    ...overrides,
  };
}

function harness(count: number, validations?: (index: number) => RelationshipValidation) {
  const manager = { ...person(0), email: "boss@example.com", userId: "boss", employmentId: 999 };
  const employees = Array.from({ length: count }, (_unused, index) => person(index + 1));
  const counting = makeCountingDb({
    select: [
      [],
      [...employees, manager],
      [
        {
          id: "job-1",
          status: "PREVIEWED",
          jobReason: "Quarterly reorganisation",
          effectiveFrom: null,
          rowCount: count,
          readyCount: count,
          warningCount: 0,
          errorCount: 0,
          committedCount: 0,
          createdBy: ACTOR.userId,
          createdAt: new Date(),
          committedAt: null,
          cursorAt: "2026-09-26T00:00:00.000000",
        },
      ],
      [],
    ],
    insert: [[{ id: "job-1" }], []],
    execute: [[]],
  });
  const db = counting.db as Db;
  const validateMany = jest.fn((_orgId: string, commands: readonly unknown[]) =>
    Promise.resolve(commands.map((_command, index) => (validations ? validations(index) : validation()))),
  );
  const service = new ReportingLineBulkJobsService(
    db,
    { logCritical: jest.fn() } as never,
    { emit: jest.fn() } as never,
    { validateMany, setRelationships: jest.fn() } as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:employees:view", "all"]])) } as never,
  );
  const body = {
    jobReason: "Quarterly reorganisation",
    rows: employees.map((employee) => ({ employeeEmail: employee.email, primaryManagerEmail: "boss@example.com" })),
  };
  return {
    preview: () =>
      runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx: counting.db as TenantTx, afterCommit: [] }, () =>
        service.preview(ACTOR, body),
      ),
    statements: counting.statements,
    countOf: counting.countOf,
    validateMany,
  };
}

describe("ReportingLineBulkJobsService.preview", () => {
  it("previews a maximum-size (500-row) file in the same statements as a 1-row file, validating in one batch", async () => {
    const one = harness(1);
    await one.preview();
    const max = harness(500);
    await max.preview();

    expect(max.statements()).toBe(one.statements());
    expect(max.countOf("insert")).toBe(2);
    expect(max.validateMany).toHaveBeenCalledTimes(1);
    expect(max.validateMany.mock.calls[0]?.[1]).toHaveLength(500);
  });

});

describe("rejectFileCycles", () => {
  const row = (rowNumber: number, employee: ReturnType<typeof person>, manager: ReturnType<typeof person>): PlannedRow => ({
    rowNumber,
    employeeEmail: employee.email,
    employee: { ...employee, state: "active" },
    primaryManagerEmail: manager.email,
    primaryManager: { ...manager, state: "active" },
    secondaryEmails: [],
    secondary: [],
    effectiveFrom: "2026-10-01",
    reason: null,
    issues: [],
  });

  it("marks both rows of a loop that exists only inside the file as PRIMARY_CYCLE, and leaves an ordinary row alone", () => {
    const rows = [row(1, person(1), person(2)), row(2, person(2), person(1)), row(3, person(3), person(2))];
    rejectFileCycles(rows);
    expect(rows.map((entry) => entry.issues.map((issue) => issue.code))).toEqual([["PRIMARY_CYCLE"], ["PRIMARY_CYCLE"], []]);
  });
});

describe("classifyBulkRow", () => {
  const employee = { ...person(1), state: "active" as const };
  const planned = (overrides: Partial<PlannedRow> = {}): PlannedRow => ({
    rowNumber: 1,
    employeeEmail: employee.email,
    employee,
    primaryManagerEmail: "boss@example.com",
    primaryManager: { ...person(0), userId: "boss", employmentId: 999, state: "active" },
    secondaryEmails: [],
    secondary: [],
    effectiveFrom: "2026-10-01",
    reason: null,
    issues: [],
    ...overrides,
  });
  const current = new Map([[employee.employmentId, { managerEmploymentId: 2 }]]);

  it("is READY when validation passes with no warnings", () => {
    expect(classifyBulkRow(planned(), validation(), current)).toMatchObject({ status: "READY", codes: null, currentPrimaryManagerEmploymentId: 2 });
  });

  it("turns a missing per-employee reason on a repeatedly changed employee into a WARNING demanding a row reason, not an ERROR", () => {
    const row = classifyBulkRow(
      planned(),
      validation({
        ok: false,
        issues: [{ code: "CHANGE_REASON_REQUIRED", message: "Give a reason." }],
        warnings: ["PRIMARY_CHANGE_THRESHOLD_EXCEEDED"],
        primaryChangesLast24h: 3,
        requiresReason: true,
      }),
      current,
    );
    expect(row).toMatchObject({ status: "WARNING", changesLast24h: 3 });
    expect(row.codes?.split(",")).toEqual(["CHANGE_REASON_REQUIRED", "PRIMARY_CHANGE_THRESHOLD_EXCEEDED"]);
  });

  it("keeps any other refusal an ERROR, with the reason code beside it", () => {
    const row = classifyBulkRow(
      planned(),
      validation({ ok: false, issues: [{ code: "PRIMARY_CYCLE", message: "Loop." }, { code: "CHANGE_REASON_REQUIRED", message: "Reason." }] }),
      current,
    );
    expect(row).toMatchObject({ status: "ERROR", message: "Loop." });
    expect(row.codes).toContain("PRIMARY_CYCLE");
  });

  it("is an ERROR for an employee the organization does not have, with no validation at all", () => {
    const row = classifyBulkRow(
      planned({ employee: undefined, issues: [{ code: "EMPLOYEE_NOT_FOUND", message: "x@example.com is not an employee of this organization." }] }),
      undefined,
      current,
    );
    expect(row).toMatchObject({ status: "ERROR", codes: "EMPLOYEE_NOT_FOUND", employeeEmploymentId: null });
  });
});
