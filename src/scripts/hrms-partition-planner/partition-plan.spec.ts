import {
  buildPartitionPlan,
  currentAndNextThree,
  shiftMonth,
} from "./partition-plan";

describe("HRMS partition plan", () => {
  it("builds exact monthly bounds and allowlisted child names", () => {
    expect(
      buildPartitionPlan({
        tables: ["attendance_events", "hr_audit_events"],
        months: ["2026-08"],
        hashModulus: null,
      }),
    ).toEqual([
      {
        kind: "range",
        parent: "attendance_events",
        child: "attendance_events_y2026m08",
        month: "2026-08",
        from: "2026-08-01",
        to: "2026-09-01",
      },
      {
        kind: "range",
        parent: "hr_audit_events",
        child: "hr_audit_events_y2026m08",
        month: "2026-08",
        from: "2026-08-01",
        to: "2026-09-01",
      },
    ]);
  });

  it("supports the current month plus the next three across a year boundary", () => {
    expect(currentAndNextThree(new Date("2026-11-15T12:00:00Z"))).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("plans every remainder for an explicit fixed hash modulus", () => {
    const plan = buildPartitionPlan({
      tables: ["attendance_event_locators"],
      months: [],
      hashModulus: 16,
    });
    expect(plan).toHaveLength(16);
    expect(plan[0]).toEqual({
      kind: "hash",
      parent: "attendance_event_locators",
      child: "attendance_event_locators_h00",
      modulus: 16,
      remainder: 0,
    });
    expect(plan[15]).toEqual({
      kind: "hash",
      parent: "attendance_event_locators",
      child: "attendance_event_locators_h15",
      modulus: 16,
      remainder: 15,
    });
  });

  it("includes correction and audit-source families in the fixed registry", () => {
    const plan = buildPartitionPlan({
      tables: ["attendance_correction_links", "hr_audit_event_sources"],
      months: [],
      hashModulus: 16,
    });
    expect(plan).toHaveLength(32);
    expect(plan[0]?.child).toBe("attendance_correction_links_h00");
    expect(plan[31]?.child).toBe("hr_audit_event_sources_h15");
  });
});
