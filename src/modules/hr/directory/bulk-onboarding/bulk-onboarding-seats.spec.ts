import { buildOnboardingPreview, SEAT_LIMIT_CODE } from "./bulk-onboarding-results";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";
import type { BulkOnboardPlan, PlannedEmployee } from "./bulk-onboarding.types";

/**
 * BUG-HRMS-002. The preview reported "15 rows · 15 ready to create" with one
 * seat free, and the confirm step answered 402. A preview that promises a row
 * the commit will refuse is the defect, so the seat ceiling is asserted here,
 * on the row classification itself.
 */

function row(index: number): BulkOnboardEmployeeRow {
  return {
    firstName: "Asha",
    lastName: `Rao${String(index)}`,
    email: `asha${String(index)}@example.test`,
    designation: "Engineer",
    department: "Engineering",
  } as BulkOnboardEmployeeRow;
}

function planned(rows: readonly BulkOnboardEmployeeRow[]): {
  plan: BulkOnboardPlan;
  departmentsToCreate: readonly string[];
} {
  const accepted = rows.map(
    (source, index) =>
      ({
        row: index + 1,
        email: source.email,
        source,
        primaryManager: null,
        secondaryManagers: [],
      }) as unknown as PlannedEmployee,
  );
  return {
    plan: { accepted, rejected: [] } as unknown as BulkOnboardPlan,
    departmentsToCreate: [],
  };
}

describe("bulk onboard preview — seat ceiling", () => {
  it("blocks the rows past the free-seat count instead of calling them ready", () => {
    const rows = Array.from({ length: 15 }, (_unused, index) => row(index));

    const preview = buildOnboardingPreview(rows, planned(rows), {
      limit: 10,
      used: 9,
      available: 1,
    });

    expect(preview.counts.ready).toBe(1);
    expect(preview.counts.error).toBe(14);
    expect(preview.seats).toEqual({
      limit: 10,
      used: 9,
      available: 1,
      required: 15,
      blocked: 14,
    });
    expect(preview.rows[0]?.status).toBe("READY");
    expect(preview.rows[1]?.status).toBe("ERROR");
    expect(preview.rows[1]?.codes).toContain(SEAT_LIMIT_CODE);
    expect(preview.rows[1]?.messages.join(" ")).toMatch(/seat/i);
  });

  it("blocks every row when no seat is free", () => {
    const rows = [row(0)];

    const preview = buildOnboardingPreview(rows, planned(rows), {
      limit: 10,
      used: 10,
      available: 0,
    });

    expect(preview.counts.ready).toBe(0);
    expect(preview.rows[0]?.status).toBe("ERROR");
    expect(preview.rows[0]?.codes).toContain(SEAT_LIMIT_CODE);
  });

  it("blocks nothing on an unlimited plan", () => {
    const rows = Array.from({ length: 40 }, (_unused, index) => row(index));

    const preview = buildOnboardingPreview(rows, planned(rows), {
      limit: null,
      used: 12,
      available: null,
    });

    expect(preview.counts.ready).toBe(40);
    expect(preview.seats.blocked).toBe(0);
    expect(preview.seats.required).toBe(40);
  });
});
