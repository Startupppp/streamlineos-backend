import {
  assertMayCrossCells,
  CrossCellEventRefusedError,
  CROSS_CELL_EVENT_TYPES,
  isCellLocalEventType,
  isCrossCellEventType,
  mayCrossCells,
} from "./cross-cell-events";

describe("which events may cross a cell boundary", () => {
  it("admits every declared control-plane event", () => {
    for (const eventType of CROSS_CELL_EVENT_TYPES)
      expect(mayCrossCells(eventType).allowed).toBe(true);
  });

  it("refuses a tenant domain event, naming why", () => {
    const verdict = mayCrossCells("build.ticket.created");

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("cell-local");
  });

  it("refuses every event type present in the outbox today", () => {
    const observed = [
      "build.ticket.created",
      "build.project.created",
      "build.ticket.status_changed",
    ];

    for (const eventType of observed) expect(isCellLocalEventType(eventType)).toBe(true);
  });

  it("throws a typed error rather than returning a boolean the caller can ignore", () => {
    expect(() => assertMayCrossCells("hr.employee.onboarded")).toThrow(
      CrossCellEventRefusedError,
    );
  });

  it("returns the narrowed event type so a caller cannot widen it back", () => {
    expect(assertMayCrossCells("control-plane.placement.moved")).toBe(
      "control-plane.placement.moved",
    );
  });

  it("narrows without a cast", () => {
    const value: string = "control-plane.organization.purged";

    if (!isCrossCellEventType(value)) throw new Error("expected a control-plane event");
    expect(CROSS_CELL_EVENT_TYPES).toContain(value);
  });

  it("allows only control-plane events, so a new namespace cannot leak by accident", () => {
    for (const eventType of CROSS_CELL_EVENT_TYPES)
      expect(eventType.startsWith("control-plane.")).toBe(true);
  });
});
