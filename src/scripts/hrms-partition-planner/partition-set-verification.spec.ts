import { assertPartitionSetRows } from "./partition-set-verification";
import type { PartitionPlanItem } from "./partition-plan";

const items: PartitionPlanItem[] = [
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
    parent: "attendance_events",
    child: "attendance_events_y2026m09",
    month: "2026-09",
    from: "2026-09-01",
    to: "2026-10-01",
  },
];

const rows = [
  {
    child_schema: "public",
    child_name: "attendance_events_y2026m08",
    relation_kind: "r",
  },
  {
    child_schema: "public",
    child_name: "attendance_events_y2026m09",
    relation_kind: "r",
  },
];

describe("HRMS partition exact set", () => {
  it("allows planned missing children only during preflight", () => {
    expect(() => assertPartitionSetRows(rows.slice(0, 1), items, true))
      .not.toThrow();
    expect(() => assertPartitionSetRows(rows.slice(0, 1), items, false))
      .toThrow("PARTITION_SET_INCOMPLETE");
  });

  it("accepts the exact final direct-leaf set", () => {
    expect(() => assertPartitionSetRows(rows, items, false)).not.toThrow();
  });

  it.each([
    [{ ...rows[0], child_name: "attendance_events_y2026m07" }],
    [{ ...rows[0], child_schema: "shadow" }],
    [{ ...rows[0], relation_kind: "p" }],
  ])("rejects an unapproved direct child shape", (actual) => {
    expect(() => assertPartitionSetRows([actual], items, true))
      .toThrow("PARTITION_SET_UNAPPROVED_CHILD");
  });
});
