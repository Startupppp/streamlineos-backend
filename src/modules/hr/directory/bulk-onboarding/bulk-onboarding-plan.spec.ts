import { planBulkOnboarding } from "./bulk-onboarding-plan";
import type { DepartmentCatalog } from "./bulk-onboarding-departments";
import type { AdmissionScreen } from "../../../organization/core/membership-admission.service";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";

/**
 * V-031/V-032. Two row-level outcomes the plan is responsible for and nothing
 * drove end to end.
 *
 * The under-16 row was validated on the ARRAY schema, so one bad date of birth
 * 400'd the whole upload and created nobody; the per-row reason QA reported
 * came from the frontend preview, not from here. And the dependent-rejection
 * sweep — a row whose manager row failed — was only covered at the graph level,
 * where the manager's row number never appears.
 */

const CATALOG: DepartmentCatalog = {
  byKey: new Map([["engineering", "dept-eng"]]),
  activeIds: new Set(["dept-eng"]),
  usedCodes: new Set(),
  created: false,
};

const CLEAR: AdmissionScreen = { kind: "clear", userId: null };

function row(overrides: Partial<BulkOnboardEmployeeRow> = {}): BulkOnboardEmployeeRow {
  return {
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.test",
    designation: "Engineer",
    department: "Engineering",
    topLevelRole: true,
    topLevelRoleReason: "Founding team",
    ...overrides,
  } as BulkOnboardEmployeeRow;
}

function plan(rows: BulkOnboardEmployeeRow[], screens?: Map<string, AdmissionScreen>) {
  return planBulkOnboarding(
    rows,
    CATALOG,
    screens ?? new Map(rows.map((r) => [r.email.toLowerCase(), CLEAR])),
    new Map(),
    new Map(),
    new Set(),
    new Map(),
  );
}

describe("planBulkOnboarding", () => {
  it("a row whose manager row failed is rejected citing the manager's row", () => {
    // Row 2 names an unknown department and fails. Row 3 reports to row 2, so it
    // cannot be created either — and the operator has to be able to see WHY,
    // which means the message has to point at the row that actually broke.
    const result = plan([
      row({ email: "founder@example.test" }),
      row({
        email: "lead@example.test",
        department: "Ministry of Silly Walks",
      }),
      row({
        email: "report@example.test",
        topLevelRole: false,
        topLevelRoleReason: undefined,
        reportingManagerEmail: "lead@example.test",
      }),
    ]);

    expect(result.accepted.map((entry) => entry.email)).toEqual(["founder@example.test"]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        row: 2,
        email: "lead@example.test",
        error: expect.stringContaining("Ministry of Silly Walks"),
      }),
      {
        row: 3,
        email: "report@example.test",
        success: false,
        error:
          'Reporting manager "lead@example.test" failed on row 2, so this row was not created either.',
      },
    ]);
  });

  it("rejects only the under-16 row and still onboards the rest of the file", () => {
    // The whole point of moving this off the array schema: one bad date of birth
    // used to 400 the upload and create nobody.
    const result = plan([
      row({ email: "adult@example.test", dateOfBirth: "1990-04-02" }),
      row({ email: "child@example.test", dateOfBirth: "2019-04-02" }),
      row({ email: "other@example.test" }),
    ]);

    expect(result.accepted.map((entry) => entry.email)).toEqual([
      "adult@example.test",
      "other@example.test",
    ]);
    expect(result.rejected).toEqual([
      {
        row: 2,
        email: "child@example.test",
        success: false,
        error: "Employee must be at least 16 years old",
      },
    ]);
  });

  it("rejects a date of birth in the future as a row error too", () => {
    const result = plan([row({ email: "timelord@example.test", dateOfBirth: "2999-01-01" })]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.error).toBe("Date of birth cannot be in the future");
  });
});
