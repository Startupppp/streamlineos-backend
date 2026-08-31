import {
  maxSourceOffset,
  pendingEventCount,
  reconcileOffsets,
  type SourceEvent,
  type TargetInboxEntry,
} from "./relocation-offsets";

function sourceEvent(
  overrides: Partial<SourceEvent> & Pick<SourceEvent, "outboxEventId" | "eventId">,
): SourceEvent {
  return {
    deliveryState: "DELIVERED",
    aggregateType: "ticket",
    aggregateId: "t-1",
    aggregateVersion: 1,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function inboxEntry(
  overrides: Partial<TargetInboxEntry> & Pick<TargetInboxEntry, "producerEventId">,
): TargetInboxEntry {
  return {
    consumerName: "relay",
    processedAt: new Date("2026-01-01T01:00:00Z"),
    status: "COMPLETED",
    ...overrides,
  };
}

describe("reconcileOffsets — all delivered", () => {
  it("returns ok=true with all events in delivered when each appears in the target inbox", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "evt-1", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 2, eventId: "evt-2", deliveryState: "DELIVERED" }),
    ];
    const inbox: TargetInboxEntry[] = [
      inboxEntry({ producerEventId: "evt-1" }),
      inboxEntry({ producerEventId: "evt-2" }),
    ];
    const result = reconcileOffsets(events, inbox, "org-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.delivered).toContain("evt-1");
    expect(result.delivered).toContain("evt-2");
    expect(result.toReplay).toHaveLength(0);
  });
});

describe("reconcileOffsets — events needing replay", () => {
  it("puts PENDING events into toReplay when they are not in the target inbox", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "evt-new", deliveryState: "PENDING" }),
    ];
    const result = reconcileOffsets(events, [], "org-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toReplay.map((e) => e.eventId)).toContain("evt-new");
  });

  it("puts DEAD events into toReplay — dead events need a retry on the target", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 3, eventId: "evt-dead", deliveryState: "DEAD" }),
    ];
    const result = reconcileOffsets(events, [], "org-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toReplay.map((e) => e.eventId)).toContain("evt-dead");
  });

  it("puts SUPPRESSED events into suppressed list, not replay", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 4, eventId: "evt-sup", deliveryState: "SUPPRESSED" }),
    ];
    const result = reconcileOffsets(events, [], "org-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.suppressed).toContain("evt-sup");
    expect(result.toReplay).toHaveLength(0);
  });
});

describe("reconcileOffsets — indeterminate events", () => {
  it("returns ok=false when an IN_FLIGHT event is in a non-completed target inbox entry", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 5, eventId: "evt-ambig", deliveryState: "IN_FLIGHT" }),
    ];
    const inbox: TargetInboxEntry[] = [
      {
        producerEventId: "evt-ambig",
        consumerName: "relay",
        processedAt: null,
        status: "PENDING",
      },
    ];
    const result = reconcileOffsets(events, inbox, "org-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("INDETERMINATE");
    expect(result.indeterminate).toHaveLength(1);
    expect(result.indeterminate[0]?.eventId).toBe("evt-ambig");
  });

  it("a DELIVERED source event that is in-flight on target is indeterminate", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 6, eventId: "evt-conflict", deliveryState: "DELIVERED" }),
    ];
    const inbox: TargetInboxEntry[] = [
      {
        producerEventId: "evt-conflict",
        consumerName: "relay",
        processedAt: null,
        status: "PENDING",
      },
    ];
    const result = reconcileOffsets(events, inbox, "org-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("INDETERMINATE");
  });

  it("a single indeterminate event among many stops the entire reconciliation", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 7, eventId: "evt-ok", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 8, eventId: "evt-ambig", deliveryState: "IN_FLIGHT" }),
    ];
    const inbox: TargetInboxEntry[] = [
      inboxEntry({ producerEventId: "evt-ok" }),
      {
        producerEventId: "evt-ambig",
        consumerName: "relay",
        processedAt: null,
        status: "PENDING",
      },
    ];
    const result = reconcileOffsets(events, inbox, "org-1");
    expect(result.ok).toBe(false);
  });
});

describe("reconcileOffsets — mixed scenario", () => {
  it("correctly classifies a realistic mix of event states", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 10, eventId: "delivered-1", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 11, eventId: "delivered-2", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 12, eventId: "pending-catch-up", deliveryState: "PENDING" }),
      sourceEvent({ outboxEventId: 13, eventId: "suppressed-1", deliveryState: "SUPPRESSED" }),
      sourceEvent({ outboxEventId: 14, eventId: "dead-retry", deliveryState: "DEAD" }),
    ];
    const inbox: TargetInboxEntry[] = [
      inboxEntry({ producerEventId: "delivered-1" }),
      inboxEntry({ producerEventId: "delivered-2" }),
    ];
    const result = reconcileOffsets(events, inbox, "org-mixed");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.delivered).toHaveLength(2);
    expect(result.toReplay).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
    expect(result.toReplay.map((e) => e.eventId)).toContain("pending-catch-up");
    expect(result.toReplay.map((e) => e.eventId)).toContain("dead-retry");
  });
});

describe("reconcileOffsets — guard", () => {
  it("throws if orgId is empty", () => {
    expect(() => reconcileOffsets([], [], "")).toThrow();
  });
});

describe("maxSourceOffset", () => {
  it("returns 0 for an empty list", () => {
    expect(maxSourceOffset([])).toBe(0);
  });

  it("returns the highest outboxEventId", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 5, eventId: "e1" }),
      sourceEvent({ outboxEventId: 100, eventId: "e2" }),
      sourceEvent({ outboxEventId: 3, eventId: "e3" }),
    ];
    expect(maxSourceOffset(events)).toBe(100);
  });
});

describe("pendingEventCount", () => {
  it("counts PENDING and IN_FLIGHT events — these represent active writes during CATCH_UP", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "e1", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 2, eventId: "e2", deliveryState: "PENDING" }),
      sourceEvent({ outboxEventId: 3, eventId: "e3", deliveryState: "IN_FLIGHT" }),
      sourceEvent({ outboxEventId: 4, eventId: "e4", deliveryState: "DEAD" }),
    ];
    expect(pendingEventCount(events)).toBe(2);
  });

  it("returns 0 for an idle org — the state an CATCH_UP test never sees in the happy path", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "e1", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 2, eventId: "e2", deliveryState: "DELIVERED" }),
    ];
    expect(pendingEventCount(events)).toBe(0);
  });
});
