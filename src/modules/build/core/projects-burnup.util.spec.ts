import { computeBurnupFromEvents } from "./projects-burnup.util";

describe("computeBurnupFromEvents", () => {
  it("tracks scope, estimate changes, completion, removal, and reopening by day", () => {
    const result = computeBurnupFromEvents(
      [
        { ticketId: 1, eventType: "added", newPoints: 3, createdAt: new Date(2026, 0, 1, 9) },
        { ticketId: 2, eventType: "added", newPoints: 5, createdAt: new Date(2026, 0, 1, 10) },
        { ticketId: 1, eventType: "completed", newPoints: null, createdAt: new Date(2026, 0, 2, 10) },
        { ticketId: 2, eventType: "estimate_changed", newPoints: 8, createdAt: new Date(2026, 0, 2, 11) },
        { ticketId: 1, eventType: "removed", newPoints: null, createdAt: new Date(2026, 0, 3, 10) },
        { ticketId: 2, eventType: "completed", newPoints: null, createdAt: new Date(2026, 0, 3, 11) },
        { ticketId: 2, eventType: "reopened", newPoints: null, createdAt: new Date(2026, 0, 4, 10) },
      ],
      new Date(2026, 0, 1),
      4,
    );

    expect(result).toEqual([
      { date: "2026-01-01", scope: 8, completed: 0 },
      { date: "2026-01-02", scope: 11, completed: 3 },
      { date: "2026-01-03", scope: 8, completed: 8 },
      { date: "2026-01-04", scope: 8, completed: 0 },
    ]);
  });

  it("caps completed points at current scope after an estimate reduction", () => {
    const result = computeBurnupFromEvents(
      [
        { ticketId: 1, eventType: "added", newPoints: 5, createdAt: new Date(2026, 0, 1, 9) },
        { ticketId: 1, eventType: "completed", newPoints: null, createdAt: new Date(2026, 0, 1, 10) },
        { ticketId: 1, eventType: "estimate_changed", newPoints: 2, createdAt: new Date(2026, 0, 2, 9) },
      ],
      new Date(2026, 0, 1),
      2,
    );

    expect(result[1]).toEqual({ date: "2026-01-02", scope: 2, completed: 2 });
  });
});
