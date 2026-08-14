import { NotificationCircuitBreaker } from "./notification-circuit-breaker";

/**
 * PIPE-010. The failure this guards against is an outage costing one provider round trip
 * per queued notification, indefinitely — which is both slow and the thing that gets a
 * sender reputation downgraded.
 */
describe("NotificationCircuitBreaker", () => {
  const ORG = "org-a";
  const OTHER = "org-b";
  const T0 = 1_000_000;

  function failTimes(b: NotificationCircuitBreaker, n: number, org = ORG, channel = "EMAIL") {
    let opened = false;
    for (let i = 0; i < n; i++) opened = b.recordFailure(org, channel, T0) || opened;
    return opened;
  }

  it("stays closed below the threshold", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 4);
    expect(b.check(ORG, "EMAIL", T0).open).toBe(false);
  });

  it("opens on the threshold failure and reports when to retry", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    expect(failTimes(b, 5)).toBe(true);

    const decision = b.check(ORG, "EMAIL", T0);
    expect(decision.open).toBe(true);
    expect(decision.retryAfterMs).toBe(60_000);
  });

  it("reports a shrinking retry delay as the cooldown elapses", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5);
    expect(b.check(ORG, "EMAIL", T0 + 20_000).retryAfterMs).toBe(40_000);
  });

  // Half-open. Without a probe the breaker would never discover the provider recovered.
  it("lets a single probe through once the cooldown expires", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5);
    expect(b.check(ORG, "EMAIL", T0 + 60_000).open).toBe(false);
  });

  it("re-opens immediately when the probe fails, without a fresh threshold", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5);
    b.check(ORG, "EMAIL", T0 + 60_000);

    // One failure, not five: the counter is retained through the half-open probe.
    expect(b.recordFailure(ORG, "EMAIL", T0 + 60_001)).toBe(true);
    expect(b.check(ORG, "EMAIL", T0 + 60_002).open).toBe(true);
  });

  it("closes and resets after a successful probe", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5);
    b.check(ORG, "EMAIL", T0 + 60_000);
    b.recordSuccess(ORG, "EMAIL");

    expect(b.check(ORG, "EMAIL", T0 + 60_001).open).toBe(false);
    // Reset means a later outage needs the full threshold again, not one failure.
    expect(failTimes(b, 4, ORG, "EMAIL")).toBe(false);
  });

  // The isolation that matters: one tenant's broken SMTP credentials must not stop email
  // for everyone else, and a dead SMS provider must not stop email for the same tenant.
  it("isolates the breaker per organization and per channel", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5, ORG, "EMAIL");

    expect(b.check(ORG, "EMAIL", T0).open).toBe(true);
    expect(b.check(OTHER, "EMAIL", T0).open).toBe(false);
    expect(b.check(ORG, "SMS", T0).open).toBe(false);
  });

  it("does not re-open an already-open breaker on further failures", () => {
    const b = new NotificationCircuitBreaker(5, 60_000);
    failTimes(b, 5);
    expect(b.recordFailure(ORG, "EMAIL", T0 + 1)).toBe(false);
  });
});
