import {
  CARRIER_MAX_ATTEMPTS,
  CARRIER_RETRY_SCHEDULE_MS,
  CarrierAdapterRegistry,
  MANUAL_CARRIER_ADAPTER,
  TerminalCarrierError,
  type CarrierAdapter,
  type CarrierTrackingEvent,
  nextCarrierAttemptDelayMs,
  planCarrierAttempt,
  runCarrierCall,
} from "../carrier-adapter";

/**
 * B7, item 2 — the carrier boundary, exercised against a fake.
 *
 * **Stated plainly: there is no real carrier here.** No account, no credential,
 * no HTTP. Every carrier in these tests is a function this file wrote, and that
 * is the honest shape of the test rather than a shortcut around one — an
 * integration test against a courier's sandbox would prove that courier works
 * today, and would prove nothing about the retry ladder, which is the part every
 * future adapter shares and the part that is expensive to get wrong.
 *
 * So the fake is not standing in for a carrier we could have used. It is
 * standing in for the *failure modes* a carrier has, which are exactly the
 * things a real integration makes hard to reproduce on demand: an endpoint that
 * hangs, one that fails twice and then works, one that says "no such parcel".
 */

/** Backoff and deadline are driven, never waited on. */
const instant = (): Promise<void> => Promise.resolve();
const never = (): Promise<void> => new Promise<void>(() => undefined);

function fakeCarrier(
  code: string,
  fetchTracking: CarrierAdapter["fetchTracking"],
): CarrierAdapter {
  return { code, canPoll: true, fetchTracking };
}

const EVENT: CarrierTrackingEvent = {
  trackingNumber: "TRK-1",
  status: "DELIVERED",
  occurredAt: "2026-08-29T10:00:00.000Z",
  carrierEventId: "evt-1",
};

describe("carrier retry policy", () => {
  it("walks the schedule in order and then stops", () => {
    expect(nextCarrierAttemptDelayMs(1)).toBe(CARRIER_RETRY_SCHEDULE_MS[0]);
    expect(nextCarrierAttemptDelayMs(2)).toBe(CARRIER_RETRY_SCHEDULE_MS[1]);
    expect(nextCarrierAttemptDelayMs(CARRIER_MAX_ATTEMPTS)).toBeNull();
  });

  it("stops being retryable exactly when the schedule runs out", () => {
    let attempts = 0;
    const seen: Array<number | null> = [];
    for (;;) {
      const plan = planCarrierAttempt({ attempts, ok: false });
      attempts = plan.attempts;
      seen.push(plan.retryInMs);
      if (plan.deadLettered) break;
    }
    expect(attempts).toBe(CARRIER_MAX_ATTEMPTS);
    expect(seen.slice(0, -1)).toEqual([...CARRIER_RETRY_SCHEDULE_MS]);
    expect(seen.at(-1)).toBeNull();
  });

  it("does not retry a failure the caller has called terminal", () => {
    const plan = planCarrierAttempt({ attempts: 0, ok: false, terminal: true });
    expect(plan.attempts).toBe(1);
    expect(plan.deadLettered).toBe(true);
  });
});

describe("runCarrierCall", () => {
  it("answers on the first attempt when the carrier answers", async () => {
    const result = await runCarrierCall(() => Promise.resolve([EVENT]), {
      sleep: instant,
      timer: never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual([EVENT]);
    expect(result.attempts).toBe(1);
  });

  it("retries a transient failure rather than giving up on it", async () => {
    let calls = 0;
    const result = await runCarrierCall(
      () => {
        calls += 1;
        return calls < 2 ? Promise.reject(new Error("502")) : Promise.resolve([EVENT]);
      },
      { sleep: instant, timer: never },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("dead-letters once the ladder is exhausted, and says so as a value", async () => {
    let calls = 0;
    const result = await runCarrierCall(
      () => {
        calls += 1;
        return Promise.reject(new Error("carrier is down"));
      },
      { sleep: instant, timer: never },
    );
    // A value, not a throw. The parcel is on a van whatever the courier's API
    // says, so nothing upstream may be tempted to roll a shipment back.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.deadLettered).toBe(true);
    expect(result.reason).toBe("error");
    expect(result.error).toContain("carrier is down");
    expect(result.attempts).toBe(CARRIER_MAX_ATTEMPTS);
    expect(calls).toBe(CARRIER_MAX_ATTEMPTS);
  });

  it("treats a carrier that never answers as a timeout, and retries it", async () => {
    let calls = 0;
    const result = await runCarrierCall(
      () => {
        calls += 1;
        // The failure mode that makes an unbounded call dangerous: a socket the
        // courier never closes would otherwise hold a request handler open for
        // as long as they felt like it.
        return new Promise<CarrierTrackingEvent[]>(() => undefined);
      },
      { sleep: instant, timer: instant },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
    expect(result.attempts).toBe(CARRIER_MAX_ATTEMPTS);
    expect(calls).toBe(CARRIER_MAX_ATTEMPTS);
  });

  it("dead-letters a terminal answer immediately instead of asking twice", async () => {
    let calls = 0;
    const result = await runCarrierCall(
      () => {
        calls += 1;
        return Promise.reject(new TerminalCarrierError("no such tracking number"));
      },
      { sleep: instant, timer: never },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(1);
    // Retrying a definite "no" is a way of turning one wrong answer into three.
    expect(calls).toBe(1);
  });

  it("does not let a late failure escape as an unhandled rejection", async () => {
    // The losing half of the race still settles. Left unattended it would
    // surface minutes later and take the process down with it, long after the
    // request it belonged to was answered.
    const control: { reject: ((error: Error) => void) | null } = { reject: null };
    const result = await runCarrierCall(
      () =>
        new Promise<CarrierTrackingEvent[]>((_resolve, rej) => {
          control.reject = rej;
        }),
      { sleep: instant, timer: instant },
    );
    expect(result.ok).toBe(false);
    control.reject?.(new Error("arrived after the deadline"));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("the manual adapter", () => {
  it("says there is nobody to ask rather than pretending to poll", async () => {
    expect(MANUAL_CARRIER_ADAPTER.canPoll).toBe(false);
    await expect(
      MANUAL_CARRIER_ADAPTER.fetchTracking({ trackingNumber: "TRK-1", carrierCode: "manual" }),
    ).resolves.toEqual([]);
  });
});

describe("CarrierAdapterRegistry", () => {
  it("falls back to manual for a carrier code nobody has written an adapter for", () => {
    const registry = new CarrierAdapterRegistry();
    // The tenant's own free-text code. It may not become a route, so an unknown
    // one is manual tracking rather than a 500.
    expect(registry.forCarrier("FEDEX")).toBe(MANUAL_CARRIER_ADAPTER);
    expect(registry.forCarrier(null)).toBe(MANUAL_CARRIER_ADAPTER);
    expect(registry.forCarrier("")).toBe(MANUAL_CARRIER_ADAPTER);
  });

  it("resolves a registered adapter regardless of how the tenant cased its code", () => {
    const registry = new CarrierAdapterRegistry();
    const fake = fakeCarrier("PARCELCO", () => Promise.resolve([EVENT]));
    registry.register(fake);
    expect(registry.forCarrier("parcelco")).toBe(fake);
    expect(registry.forCarrier("  ParcelCo ")).toBe(fake);
  });
});
