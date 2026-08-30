import {
  assertTransitionAllowed,
  canRollback,
  isResumable,
  isTerminal,
  nextState,
  RELOCATION_STATES,
  RelocationTransitionError,
  resumeFrom,
  rollbackTargetFor,
  type RelocationState,
} from "./relocation-state";

describe("forward state machine", () => {
  const HAPPY_PATH: RelocationState[] = [
    "ACTIVE_SOURCE",
    "SNAPSHOT",
    "CATCH_UP",
    "READ_ONLY_SOURCE",
    "VERIFY_TARGET",
    "FLIP_PLACEMENT",
    "ACTIVE_TARGET",
    "RETIRE_SOURCE",
  ];

  const EVENTS = [
    "BEGIN",
    "SNAPSHOT_DONE",
    "CATCH_UP_DONE",
    "VERIFY_STARTED",
    "VERIFY_DONE",
    "FLIP_DONE",
    "RETIRE_STARTED",
  ] as const;

  it("advances through the happy path one event at a time", () => {
    for (let i = 0; i < EVENTS.length; i++) {
      const current = HAPPY_PATH[i] as RelocationState;
      const expected = HAPPY_PATH[i + 1] as RelocationState;
      const result = nextState(current, EVENTS[i]);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.state).toBe(expected);
    }
  });

  it("refuses a FAIL event from a terminal state", () => {
    const result = nextState("FAILED", "FAIL");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("TERMINAL_STATE");
  });

  it("allows a FAIL event from any non-terminal, non-retired state", () => {
    const failableStates: RelocationState[] = [
      "ACTIVE_SOURCE",
      "SNAPSHOT",
      "CATCH_UP",
      "READ_ONLY_SOURCE",
      "VERIFY_TARGET",
      "FLIP_PLACEMENT",
      "ACTIVE_TARGET",
    ];
    for (const state of failableStates) {
      const result = nextState(state, "FAIL");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.state).toBe("FAILED");
    }
  });

  it("refuses a FAIL event from RETIRE_SOURCE because it has no forward transitions", () => {
    const result = nextState("RETIRE_SOURCE", "FAIL");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("UNKNOWN_EVENT_FOR_STATE");
  });

  it("refuses an event that does not match the current state", () => {
    const result = nextState("SNAPSHOT", "CATCH_UP_DONE");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("UNKNOWN_EVENT_FOR_STATE");
  });

  it("covers every declared state so a new state must be handled", () => {
    for (const state of RELOCATION_STATES) {
      const terminal = isTerminal(state);
      expect(typeof terminal).toBe("boolean");
    }
  });
});

describe("assertTransitionAllowed", () => {
  it("allows a valid transition without throwing", () => {
    expect(() => assertTransitionAllowed("ACTIVE_SOURCE", "SNAPSHOT")).not.toThrow();
  });

  it("throws RelocationTransitionError for an illegal transition", () => {
    expect(() => assertTransitionAllowed("ACTIVE_SOURCE", "RETIRE_SOURCE")).toThrow(
      RelocationTransitionError,
    );
  });

  it("throws for any transition out of a terminal state", () => {
    expect(() => assertTransitionAllowed("FAILED", "ACTIVE_SOURCE")).toThrow(
      RelocationTransitionError,
    );
    expect(() => assertTransitionAllowed("ROLLED_BACK", "SNAPSHOT")).toThrow(
      RelocationTransitionError,
    );
  });

  it("carries the ILLEGAL_TRANSITION code on the thrown error", () => {
    try {
      assertTransitionAllowed("SNAPSHOT", "ACTIVE_TARGET");
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelocationTransitionError);
      const typed = err as RelocationTransitionError;
      expect(typed.code).toBe("ILLEGAL_TRANSITION");
    }
  });
});

describe("canRollback", () => {
  it("returns true for every pre-flip state", () => {
    const rollbackableStates: RelocationState[] = [
      "ACTIVE_SOURCE",
      "SNAPSHOT",
      "CATCH_UP",
      "READ_ONLY_SOURCE",
      "VERIFY_TARGET",
    ];
    for (const state of rollbackableStates)
      expect(canRollback(state)).toBe(true);
  });

  it("returns false from FLIP_PLACEMENT onward — rollback is a fresh relocation", () => {
    const noRollbackStates: RelocationState[] = [
      "FLIP_PLACEMENT",
      "ACTIVE_TARGET",
      "RETIRE_SOURCE",
      "ROLLED_BACK",
      "FAILED",
    ];
    for (const state of noRollbackStates)
      expect(canRollback(state)).toBe(false);
  });
});

describe("isTerminal", () => {
  it("marks ROLLED_BACK and FAILED as terminal", () => {
    expect(isTerminal("ROLLED_BACK")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
  });

  it("does not mark RETIRE_SOURCE as terminal — it is the success state", () => {
    expect(isTerminal("RETIRE_SOURCE")).toBe(false);
  });

  it("does not mark any forward state as terminal", () => {
    const forwardStates: RelocationState[] = [
      "ACTIVE_SOURCE",
      "SNAPSHOT",
      "CATCH_UP",
      "READ_ONLY_SOURCE",
      "VERIFY_TARGET",
      "FLIP_PLACEMENT",
      "ACTIVE_TARGET",
    ];
    for (const state of forwardStates)
      expect(isTerminal(state)).toBe(false);
  });
});

describe("resumeFrom", () => {
  it("returns the same state for any non-terminal state", () => {
    const resumableStates: RelocationState[] = [
      "ACTIVE_SOURCE",
      "SNAPSHOT",
      "CATCH_UP",
      "READ_ONLY_SOURCE",
      "VERIFY_TARGET",
      "FLIP_PLACEMENT",
      "ACTIVE_TARGET",
      "RETIRE_SOURCE",
    ];
    for (const state of resumableStates)
      expect(resumeFrom(state)).toBe(state);
  });

  it("throws for a terminal state — a new relocation must be started", () => {
    expect(() => resumeFrom("FAILED")).toThrow(RelocationTransitionError);
    expect(() => resumeFrom("ROLLED_BACK")).toThrow(RelocationTransitionError);
  });
});

describe("isResumable", () => {
  it("is the inverse of isTerminal", () => {
    for (const state of RELOCATION_STATES)
      expect(isResumable(state)).toBe(!isTerminal(state));
  });
});

describe("rollbackTargetFor", () => {
  it("always lands in ROLLED_BACK for rollbackable states", () => {
    const rollbackableStates: RelocationState[] = [
      "ACTIVE_SOURCE",
      "SNAPSHOT",
      "CATCH_UP",
      "READ_ONLY_SOURCE",
      "VERIFY_TARGET",
    ];
    for (const state of rollbackableStates)
      expect(rollbackTargetFor(state).landingState).toBe("ROLLED_BACK");
  });

  it("includes restore-source-writability for READ_ONLY_SOURCE", () => {
    const target = rollbackTargetFor("READ_ONLY_SOURCE");
    expect(target.compensations).toContain("restore-source-writability");
  });

  it("includes restore-source-writability for VERIFY_TARGET", () => {
    const target = rollbackTargetFor("VERIFY_TARGET");
    expect(target.compensations).toContain("restore-source-writability");
  });

  it("requires no compensations from ACTIVE_SOURCE — nothing was copied", () => {
    expect(rollbackTargetFor("ACTIVE_SOURCE").compensations).toHaveLength(0);
  });
});
