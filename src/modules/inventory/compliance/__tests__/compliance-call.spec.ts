import {
  executeComplianceCall,
  COMPLIANCE_MAX_ATTEMPTS,
  COMPLIANCE_CALL_TIMEOUT_MS,
  type ComplianceResult,
} from "../india-compliance-adapter";

/**
 * E5 — the retry ladder and the call timeout, at the seam that walks them.
 *
 * `planComplianceAttempt` decides what should happen next and was already
 * proven correct. Nothing called it: the schedule, `COMPLIANCE_MAX_ATTEMPTS`
 * and `COMPLIANCE_CALL_TIMEOUT_MS` were exported, unit-tested and unreachable,
 * so a portal that refused once was recorded as a failure without a second
 * attempt, and one that never answered held the request open indefinitely.
 *
 * These exercise the executor rather than `register`, for the same reason the
 * planner is a separate function: the properties that matter — that a transient
 * failure is retried, that a terminal one is not, that a hang is abandoned —
 * are not legible through a service that is also doing settings lookups,
 * idempotency reads and a transaction.
 *
 * `sleep` is injected so the ladder is walked without waiting for it. The delays
 * themselves are `planComplianceAttempt`'s business and are tested there.
 */

const OK: ComplianceResult = {
  status: "REGISTERED",
  externalId: "IRN-STUB-1",
  acknowledgedAt: "2026-08-30T00:00:00.000Z",
  raw: {},
};

function transientFailure(): ComplianceResult {
  return { status: "FAILED", code: "503", message: "portal unavailable", terminal: false };
}

function terminalFailure(): ComplianceResult {
  return { status: "FAILED", code: "2150", message: "duplicate IRN", terminal: true };
}

const noSleep = async (): Promise<void> => undefined;

describe("executeComplianceCall", () => {
  it("retries a transient failure up to the ladder's limit", async () => {
    let calls = 0;
    const result = await executeComplianceCall(
      async () => {
        calls += 1;
        return transientFailure();
      },
      { sleep: noSleep },
    );

    expect(calls).toBe(COMPLIANCE_MAX_ATTEMPTS);
    expect(result.status).toBe("FAILED");
  });

  it("stops as soon as the portal says yes", async () => {
    let calls = 0;
    const result = await executeComplianceCall(
      async () => {
        calls += 1;
        return calls === 1 ? transientFailure() : OK;
      },
      { sleep: noSleep },
    );

    expect(calls).toBe(2);
    expect(result).toEqual(OK);
  });

  /** Retrying a duplicate IRN turns one wrong answer into three. */
  it("does not retry a terminal failure", async () => {
    let calls = 0;
    const result = await executeComplianceCall(
      async () => {
        calls += 1;
        return terminalFailure();
      },
      { sleep: noSleep },
    );

    expect(calls).toBe(1);
    expect(result.status).toBe("FAILED");
  });

  /**
   * A portal that has not answered in ten seconds is not about to, and the
   * caller is a request somebody is waiting on. Without this the promise simply
   * never settles.
   */
  it("abandons a call that never answers, rather than holding the request open", async () => {
    const result = await executeComplianceCall(() => new Promise<ComplianceResult>(() => {}), {
      sleep: noSleep,
      timeoutMs: 5,
    });

    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.code).toBe("TIMEOUT");
  });

  /**
   * An adapter that throws is an outage, not a rejection — a provider SDK
   * rejects on a socket error the same way it would on a 503. If the throw
   * escaped, `register` would propagate it to the caller instead of recording
   * a failure, and the document row nobody wrote would be the only evidence.
   */
  it("treats a thrown adapter error as a transient failure, not an escape", async () => {
    let calls = 0;
    const result = await executeComplianceCall(
      async () => {
        calls += 1;
        throw new Error("ECONNRESET");
      },
      { sleep: noSleep },
    );

    expect(calls).toBe(COMPLIANCE_MAX_ATTEMPTS);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") {
      expect(result.code).toBe("ADAPTER_THREW");
      expect(result.message).toContain("ECONNRESET");
    }
  });

  it("has a default timeout rather than relying on every caller to pass one", () => {
    expect(COMPLIANCE_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
