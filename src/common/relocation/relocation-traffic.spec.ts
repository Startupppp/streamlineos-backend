import {
  assertRetireGateOpen,
  evaluateRetireGate,
  RETIRE_GATE,
  type TrafficRecord,
} from "./relocation-traffic";
import { RelocationTransitionError } from "./relocation-state";

const NOW = new Date("2026-08-28T12:00:00.000Z");

const WINDOW_ELAPSED = new Date(NOW.getTime() - RETIRE_GATE.windowMs - 1000);
const WINDOW_NOT_ELAPSED = new Date(NOW.getTime() - RETIRE_GATE.windowMs + 60_000);

function traffic(requestCount: number, windowStart: Date): TrafficRecord {
  return { requestCount, windowStart };
}

describe("evaluateRetireGate — gate open", () => {
  it("allows when count meets minimum and window has elapsed", () => {
    const result = evaluateRetireGate(
      traffic(RETIRE_GATE.minRequests, WINDOW_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(true);
  });

  it("boundary: exactly minRequests with elapsed window is allowed", () => {
    const result = evaluateRetireGate(
      traffic(RETIRE_GATE.minRequests, WINDOW_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(true);
  });

  it("allows when count exceeds minimum and window has elapsed", () => {
    const result = evaluateRetireGate(
      traffic(RETIRE_GATE.minRequests + 100, WINDOW_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("evaluateRetireGate — gate closed", () => {
  it("refuses when traffic record is null — no requests ever recorded", () => {
    const result = evaluateRetireGate(null, NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(/0 requests/);
    expect(result.reason).toMatch(new RegExp(`needs ${RETIRE_GATE.minRequests}`));
  });

  it("boundary: one below minRequests is refused even with elapsed window", () => {
    const result = evaluateRetireGate(
      traffic(RETIRE_GATE.minRequests - 1, WINDOW_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(
      new RegExp(`${RETIRE_GATE.minRequests - 1} requests`),
    );
    expect(result.reason).toMatch(new RegExp(`needs ${RETIRE_GATE.minRequests}`));
  });

  it("refuses when count meets minimum but window has not yet elapsed", () => {
    const result = evaluateRetireGate(
      traffic(RETIRE_GATE.minRequests, WINDOW_NOT_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(/window has not elapsed/);
  });

  it("refuses when both count is below minimum and window has not elapsed", () => {
    const result = evaluateRetireGate(
      traffic(0, WINDOW_NOT_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(/0 requests/);
    expect(result.reason).toMatch(new RegExp(`needs ${RETIRE_GATE.minRequests}`));
  });

  it("refuses when count is zero and window has elapsed — no traffic is not enough", () => {
    const result = evaluateRetireGate(
      traffic(0, WINDOW_ELAPSED),
      NOW,
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(/0 requests/);
  });
});

describe("evaluateRetireGate — reason names what is missing", () => {
  it("names the actual count and the required count in the refusal message", () => {
    const served = 3;
    const result = evaluateRetireGate(traffic(served, WINDOW_ELAPSED), NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(new RegExp(`${served} requests`));
    expect(result.reason).toMatch(new RegExp(`needs ${RETIRE_GATE.minRequests}`));
  });

  it("includes the window start timestamp in the message", () => {
    const result = evaluateRetireGate(traffic(0, WINDOW_ELAPSED), NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toMatch(WINDOW_ELAPSED.toISOString());
  });
});

describe("assertRetireGateOpen", () => {
  it("does not throw when the gate is open", () => {
    expect(() =>
      assertRetireGateOpen(traffic(RETIRE_GATE.minRequests, WINDOW_ELAPSED), NOW),
    ).not.toThrow();
  });

  it("throws RelocationTransitionError when traffic is null — zero target requests", () => {
    expect(() => assertRetireGateOpen(null, NOW)).toThrow(RelocationTransitionError);
  });

  it("throws RelocationTransitionError when count is one below the minimum", () => {
    expect(() =>
      assertRetireGateOpen(traffic(RETIRE_GATE.minRequests - 1, WINDOW_ELAPSED), NOW),
    ).toThrow(RelocationTransitionError);
  });

  it("carries ILLEGAL_TRANSITION code when thrown", () => {
    try {
      assertRetireGateOpen(null, NOW);
      fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelocationTransitionError);
      const typed = err as RelocationTransitionError;
      expect(typed.code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("the error message names count served and count needed", () => {
    const served = 7;
    try {
      assertRetireGateOpen(traffic(served, WINDOW_ELAPSED), NOW);
      fail("should have thrown");
    } catch (err) {
      const typed = err as RelocationTransitionError;
      expect(typed.message).toMatch(new RegExp(`${served} requests`));
      expect(typed.message).toMatch(new RegExp(`needs ${RETIRE_GATE.minRequests}`));
    }
  });
});
