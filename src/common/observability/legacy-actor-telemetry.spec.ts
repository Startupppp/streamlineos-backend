import {
  recordLegacyActorRead,
  recordLegacyActorWrite,
  resetLegacyActorTelemetry,
  snapshotLegacyActorTelemetry,
} from "./legacy-actor-telemetry";

beforeEach(() => resetLegacyActorTelemetry());

describe("legacy-actor-telemetry", () => {
  it("starts at zero after reset", () => {
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.reads).toBe(0);
    expect(snap.writes).toBe(0);
    expect(snap.total).toBe(0);
    expect(snap.byColumn).toEqual({});
  });

  it("increments reads independently from writes", () => {
    recordLegacyActorRead("hr_effective_dated_changes", "approved_by");
    recordLegacyActorRead("hr_effective_dated_changes", "approved_by");
    recordLegacyActorWrite("hr_effective_dated_changes", "created_by");
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.reads).toBe(2);
    expect(snap.writes).toBe(1);
    expect(snap.total).toBe(3);
  });

  it("accumulates per-column counts under the table.column key", () => {
    recordLegacyActorRead("hr_reporting_lines", "created_by");
    recordLegacyActorRead("hr_reporting_lines", "created_by");
    recordLegacyActorWrite("hr_reporting_lines", "created_by");
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.byColumn["hr_reporting_lines.created_by"]).toEqual({
      reads: 2,
      writes: 1,
    });
  });

  it("tracks separate columns independently", () => {
    recordLegacyActorRead("tickets", "assignee_id");
    recordLegacyActorWrite("tickets", "assignee_id");
    recordLegacyActorRead("deals", "owner_id");
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.byColumn["tickets.assignee_id"]).toEqual({ reads: 1, writes: 1 });
    expect(snap.byColumn["deals.owner_id"]).toEqual({ reads: 1, writes: 0 });
    expect(snap.total).toBe(3);
  });

  it("snapshot is a value — mutating it does not affect subsequent reads", () => {
    recordLegacyActorRead("hr_effective_dated_changes", "approved_by");
    const snap1 = snapshotLegacyActorTelemetry();
    snap1.byColumn["hr_effective_dated_changes.approved_by"] = { reads: 999, writes: 999 };
    const snap2 = snapshotLegacyActorTelemetry();
    expect(snap2.byColumn["hr_effective_dated_changes.approved_by"]).toEqual({
      reads: 1,
      writes: 0,
    });
  });

  it("reset clears all counters and per-column state", () => {
    recordLegacyActorRead("hr_effective_dated_changes", "approved_by");
    recordLegacyActorWrite("hr_reporting_lines", "created_by");
    resetLegacyActorTelemetry();
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.reads).toBe(0);
    expect(snap.writes).toBe(0);
    expect(snap.total).toBe(0);
    expect(Object.keys(snap.byColumn)).toHaveLength(0);
  });

  it("capturedAt is a valid ISO timestamp", () => {
    const snap = snapshotLegacyActorTelemetry();
    expect(new Date(snap.capturedAt).toISOString()).toBe(snap.capturedAt);
  });
});

describe("demonstration wiring — how lanes 07-10 adopt this counter", () => {
  it("shows the single-line wiring pattern for a write site", () => {
    const simulatedWrite = (table: string, userId: string) => {
      recordLegacyActorWrite(table, "created_by");
      return { id: 1, userId };
    };

    simulatedWrite("hr_effective_dated_changes", "user-abc");
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.writes).toBe(1);
    expect(snap.byColumn["hr_effective_dated_changes.created_by"]).toEqual({
      reads: 0,
      writes: 1,
    });
  });

  it("shows the single-line wiring pattern for a read site", () => {
    const simulatedQuery = (table: string, userId: string) => {
      recordLegacyActorRead(table, "approved_by");
      return [{ approvedBy: userId }];
    };

    simulatedQuery("hr_effective_dated_changes", "user-abc");
    const snap = snapshotLegacyActorTelemetry();
    expect(snap.reads).toBe(1);
  });
});
