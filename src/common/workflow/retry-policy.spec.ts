import {
  BASE_BACKOFF_MS,
  LEASE_MS,
  MAX_BACKOFF_MS,
  backoffMs,
  decideAfterFailure,
  leaseExpiry,
} from "./retry-policy";

const now = new Date("2026-08-23T10:00:00.000Z");

describe("backoffMs", () => {
  it("grows exponentially with the attempt", () => {
    const noJitter = 1;
    expect(backoffMs(1, noJitter)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2, noJitter)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3, noJitter)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("caps, so a long-lived run does not schedule itself into next week", () => {
    expect(backoffMs(50, 1)).toBe(MAX_BACKOFF_MS);
  });

  it("spreads retries across a window rather than firing them in lockstep", () => {
    // A provider outage fails many runs at once; without jitter they all retry
    // together and knock it over again the moment it recovers.
    const earliest = backoffMs(3, 0);
    const latest = backoffMs(3, 1);

    expect(earliest).toBeLessThan(latest);
    expect(earliest).toBe(Math.round(latest * 0.5));
  });

  it("never returns a negative or zero delay", () => {
    for (const attempt of [0, 1, 5]) {
      for (const jitter of [0, 0.5, 1]) {
        expect(backoffMs(attempt, jitter)).toBeGreaterThan(0);
      }
    }
  });
});

describe("decideAfterFailure", () => {
  it("retries while attempts remain", () => {
    const decision = decideAfterFailure({ attempt: 1, maxAttempts: 5, now, jitter: 1 });

    expect(decision.kind).toBe("retry");
    if (decision.kind !== "retry") return;
    expect(decision.runAfter.getTime()).toBe(now.getTime() + BASE_BACKOFF_MS);
  });

  it("dead-letters once the attempts are used up, rather than retrying forever", () => {
    expect(decideAfterFailure({ attempt: 5, maxAttempts: 5, now }).kind).toBe("dead-letter");
  });

  it("dead-letters rather than overshooting when the count is already past the limit", () => {
    expect(decideAfterFailure({ attempt: 9, maxAttempts: 5, now }).kind).toBe("dead-letter");
  });

  it("makes the last permitted attempt, not one fewer", () => {
    // Off by one here silently costs a retry that was configured and paid for.
    expect(decideAfterFailure({ attempt: 4, maxAttempts: 5, now }).kind).toBe("retry");
  });

  it("dead-letters immediately when only one attempt was allowed", () => {
    expect(decideAfterFailure({ attempt: 1, maxAttempts: 1, now }).kind).toBe("dead-letter");
  });

  it("carries the attempt through, so the record says how many were made", () => {
    expect(decideAfterFailure({ attempt: 3, maxAttempts: 5, now }).attempt).toBe(3);
  });
});

describe("leaseExpiry", () => {
  it("holds a run long enough for a slow step but not for a dead process", () => {
    expect(leaseExpiry(now).getTime()).toBe(now.getTime() + LEASE_MS);
  });
});
