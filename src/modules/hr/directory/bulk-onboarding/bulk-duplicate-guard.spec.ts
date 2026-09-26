import {
  MembershipAdmissionService,
  DUPLICATE_ADMISSION_EMAIL_MESSAGE,
  type AdmissionScreen,
} from "../../../organization/core/membership-admission.service";
import { planBulkOnboarding } from "./bulk-onboarding-plan";
import type { DepartmentCatalog } from "./bulk-onboarding-departments";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import { makeHarness } from "../employee-onboarding.spec-fixtures";

/**
 * V-032. Every one of these rejections existed, and each was covered somewhere
 * — but nothing drove one FILE through both halves at once, and the two halves
 * do not reject the same things. `planBulkOnboarding` catches what it can see
 * from the file and the org's state; only `admitMany` collapses two spellings
 * of one address into one seat. A file that mixes them is the realistic case,
 * and the invariant worth pinning is that every bad row comes back with its own
 * reason while the good row is still created.
 */

const ORG = "org-bulk";
const ACTOR = { orgId: ORG, userId: "actor-1" };

const CATALOG: DepartmentCatalog = {
  byKey: new Map([["engineering", "dept-eng"]]),
  activeIds: new Set(["dept-eng"]),
  usedCodes: new Set(),
  created: false,
};

const CLEAR: AdmissionScreen = { kind: "clear", userId: null };

function row(overrides: Partial<BulkOnboardEmployeeRow>): BulkOnboardEmployeeRow {
  return {
    firstName: "Asha",
    lastName: "Rao",
    designation: "Engineer",
    department: "Engineering",
    topLevelRole: true,
    topLevelRoleReason: "Founding team",
    ...overrides,
  } as BulkOnboardEmployeeRow;
}

/** File order matters: the row numbers in the reasons are 1-based positions. */
const FILE: BulkOnboardEmployeeRow[] = [
  row({ email: "asha@example.test" }),
  row({ email: "asha@example.test" }),
  row({ email: "ASHA@Example.test" }),
  row({ email: "already@example.test" }),
  row({ email: "clash@example.test", employeeId: "EMP-1" }),
  row({ email: "teen@example.test", dateOfBirth: "2019-06-01" }),
];

const SCREENS = new Map<string, AdmissionScreen>([
  ["asha@example.test", CLEAR],
  [
    "already@example.test",
    {
      kind: "conflict",
      reason: "already-member",
      message: "This person is already a member of this organization.",
      userId: "user-already",
    },
  ],
  ["clash@example.test", CLEAR],
  ["teen@example.test", CLEAR],
]);

function planFile() {
  return planBulkOnboarding(
    FILE,
    CATALOG,
    SCREENS,
    // EMP-1 is already owned by somebody else in this org.
    new Map([["EMP-1", "user-someone-else"]]),
    new Map(),
    new Set(),
      );
}

describe("a bulk file that mixes every duplicate and eligibility failure", () => {
  it("gives each bad row its own reason and still creates the one good row", async () => {
    const plan = planFile();

    // What the PLAN can see: the org's own state and each row on its own.
    expect(plan.rejected).toEqual([
      {
        row: 4,
        email: "already@example.test",
        success: false,
        error: "This person is already a member of this organization.",
      },
      {
        row: 5,
        email: "clash@example.test",
        success: false,
        error: 'Employee ID "EMP-1" is already in use in your organization.',
      },
      {
        row: 6,
        email: "teen@example.test",
        success: false,
        error: "Employee must be at least 16 years old",
      },
    ]);
    // None of them reached the accepted set, so none of them will be written.
    const acceptedRows = plan.accepted.map((entry) => entry.row);
    expect(acceptedRows).not.toContain(4);
    expect(acceptedRows).not.toContain(5);
    expect(acceptedRows).not.toContain(6);

    // The repeats survive planning — the plan has no reason to prefer one
    // spelling of an address over another — and are collapsed at admission,
    // where the seat is actually taken. Row 3 is the case variant, canonicalised
    // to the same address as rows 1 and 2.
    expect(acceptedRows).toEqual([1, 2, 3]);

    const harness = makeHarness({});
    const admission = new MembershipAdmissionService(
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      { recordSeatEvents: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const outcomes = await admission.admitMany(harness.db, {
      orgId: ORG,
      actor: ACTOR as never,
      membership: {
        createMemberships: jest
          .fn()
          .mockImplementation(
            async (_tx: unknown, input: { members: { userId: string }[] }) =>
              new Map(input.members.map((member, i) => [member.userId, i + 1])),
          ),
      } as never,
      candidates: plan.accepted.map((employee) => ({
        email: employee.email,
        role: employee.role,
        screen: employee.clearance,
        createUserIfMissing: { firstName: employee.firstName, lastName: employee.lastName, isActive: true },
      })),
    });

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "admitted",
      "conflict",
      "conflict",
    ]);
    expect(outcomes[1]).toMatchObject({
      reason: "duplicate-in-batch",
      message: DUPLICATE_ADMISSION_EMAIL_MESSAGE,
    });
    expect(outcomes[2]).toMatchObject({
      reason: "duplicate-in-batch",
      message: DUPLICATE_ADMISSION_EMAIL_MESSAGE,
    });

    // The positive half: exactly one seat was taken for the three spellings.
    expect(
      harness.inserted.filter((entry) => entry.table === "users"),
    ).toHaveLength(1);
  });

  it("the under-16 row is a ROW error, not a rejection of the whole file", () => {
    // Before V-031 the refinement sat on `bulkOnboardEmployeeRowSchema`, which
    // `bulkOnboardEmployeesSchema` validates as an ARRAY — so row 6 here would
    // have 400'd the request and rows 1-5 would never have been planned at all.
    const plan = planFile();

    expect(plan.accepted.length).toBeGreaterThan(0);
    expect(plan.rejected.map((entry) => entry.row)).toContain(6);
  });
});
