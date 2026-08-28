import {
  canRollback,
  nextState,
  RelocationTransitionError,
  rollbackTargetFor,
  type RelocationState,
} from "./relocation-state";
import {
  reconcileOffsets,
  type SourceEvent,
  type TargetInboxEntry,
} from "./relocation-offsets";

function sourceEvent(
  overrides: Partial<SourceEvent> & Pick<SourceEvent, "outboxEventId" | "eventId">,
): SourceEvent {
  return {
    deliveryState: "PENDING",
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

describe("rollback before the placement flip", () => {
  const rollbackableStates: RelocationState[] = [
    "ACTIVE_SOURCE",
    "SNAPSHOT",
    "CATCH_UP",
    "READ_ONLY_SOURCE",
    "VERIFY_TARGET",
  ];

  it.each(rollbackableStates)(
    "accepts ROLLBACK event from %s and lands in ROLLED_BACK",
    (state) => {
      const result = nextState(state, "ROLLBACK");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.state).toBe("ROLLED_BACK");
    },
  );

  it.each(rollbackableStates)(
    "canRollback(%s) is true",
    (state) => {
      expect(canRollback(state)).toBe(true);
    },
  );

  it.each(rollbackableStates)(
    "rollbackTargetFor(%s) includes compensations appropriate to the copy depth",
    (state) => {
      const target = rollbackTargetFor(state);
      expect(target.landingState).toBe("ROLLED_BACK");
      expect(Array.isArray(target.compensations)).toBe(true);
    },
  );
});

describe("rollback after the placement flip is a new relocation, not a rollback", () => {
  const postFlipStates: RelocationState[] = [
    "FLIP_PLACEMENT",
    "ACTIVE_TARGET",
    "RETIRE_SOURCE",
  ];

  it.each(postFlipStates)(
    "ROLLBACK event is rejected from %s",
    (state) => {
      const result = nextState(state, "ROLLBACK");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("UNKNOWN_EVENT_FOR_STATE");
    },
  );

  it.each(postFlipStates)(
    "canRollback(%s) is false",
    (state) => {
      expect(canRollback(state)).toBe(false);
    },
  );

  it.each(postFlipStates)(
    "rollbackTargetFor(%s) throws rather than silently succeeding",
    (state) => {
      expect(() => rollbackTargetFor(state)).toThrow(RelocationTransitionError);
    },
  );

  it("the error message from rollbackTargetFor explains the new-relocation rule", () => {
    try {
      rollbackTargetFor("FLIP_PLACEMENT");
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelocationTransitionError);
      const typed = err as RelocationTransitionError;
      expect(typed.message).toMatch(/fresh relocation/i);
    }
  });
});

describe("an organization actively writing during CATCH_UP", () => {
  it("identifies events written after the snapshot as needing replay on rollback", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "evt-delivered-1", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 2, eventId: "evt-delivered-2", deliveryState: "DELIVERED" }),
      sourceEvent({ outboxEventId: 3, eventId: "evt-catch-up-1", deliveryState: "PENDING" }),
      sourceEvent({ outboxEventId: 4, eventId: "evt-catch-up-2", deliveryState: "IN_FLIGHT" }),
    ];

    const inbox: TargetInboxEntry[] = [
      inboxEntry({ producerEventId: "evt-delivered-1" }),
      inboxEntry({ producerEventId: "evt-delivered-2" }),
    ];

    const result = reconcileOffsets(events, inbox, "org-catch-up-test");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toReplay.map((e) => e.eventId)).toContain("evt-catch-up-1");
    expect(result.toReplay.map((e) => e.eventId)).toContain("evt-catch-up-2");
    expect(result.delivered).toContain("evt-delivered-1");
    expect(result.delivered).toContain("evt-delivered-2");
  });

  it("CATCH_UP is the state that cannot be simulated by an idle org — pending events prove we entered it", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "evt-1", deliveryState: "PENDING" }),
      sourceEvent({ outboxEventId: 2, eventId: "evt-2", deliveryState: "IN_FLIGHT" }),
    ];

    const result = reconcileOffsets(events, [], "org-active-writer");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.toReplay).toHaveLength(2);
    expect(result.delivered).toHaveLength(0);
  });

  it("compensations for CATCH_UP rollback include halting the relay", () => {
    const target = rollbackTargetFor("CATCH_UP");
    expect(target.compensations).toContain("halt-catch-up-relay");
    expect(target.compensations).toContain("discard-target-data");
  });
});

describe("indeterminate events stop the move", () => {
  it("returns ok=false when an event cannot be proven delivered or undelivered", () => {
    const events: SourceEvent[] = [
      sourceEvent({ outboxEventId: 1, eventId: "evt-ambiguous", deliveryState: "IN_FLIGHT" }),
    ];

    const inbox: TargetInboxEntry[] = [
      {
        producerEventId: "evt-ambiguous",
        consumerName: "relay",
        processedAt: null,
        status: "PENDING",
      },
    ];

    const result = reconcileOffsets(events, inbox, "org-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("INDETERMINATE");
    expect(result.indeterminate.some((e) => e.eventId === "evt-ambiguous")).toBe(true);
  });
});

describe("rollback from ROLLED_BACK and FAILED is rejected by the event table", () => {
  it("ROLLBACK event from ROLLED_BACK is rejected at nextState because the state is terminal", () => {
    const result = nextState("ROLLED_BACK", "ROLLBACK");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("TERMINAL_STATE");
  });

  it("ROLLBACK event from FAILED is rejected at nextState because the state is terminal", () => {
    const result = nextState("FAILED", "ROLLBACK");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("TERMINAL_STATE");
  });
});
