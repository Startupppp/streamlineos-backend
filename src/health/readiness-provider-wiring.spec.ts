/**
 * The readiness provider check read a circuit breaker nothing in the
 * application ever writes.
 *
 * `health.controller.ts:80` wired `providerCheck` to
 * `sharedProviderBreaker.openProviders(now)`. `sharedProviderBreaker` is only
 * the DEFAULT argument of `callProvider` (`call-provider.ts:105`), and all three
 * production call sites pass their own instance instead —
 * `razorpay.adapter.ts:57`, `webhooks-dispatch.service.ts:115`,
 * `projects-webhooks-dispatch.service.ts:118`. Its state map was therefore
 * permanently empty, `openProviders(now)` always returned `[]`, and
 * `dependency-checks.ts:115-117` computed `required.filter(p => open.has(p))`
 * over an empty set. Set `READINESS_REQUIRED_PROVIDERS=razorpay` and the check
 * reports `up` through a total payment-provider outage: it renders and never
 * denies.
 *
 * Compounding it, the descriptor key the adapter actually registers is
 * `razorpay-orders`, so even a fed shared breaker would never have matched the
 * word an operator puts in the environment variable.
 *
 * Both halves are pinned here. The existing `dependency-checks.spec.ts` could
 * not see either, because it hands `providerCheck` a hand-written
 * `() => ["razorpay"]` — it tests the filter, never the wiring behind it.
 */
import { callProvider } from "../common/outbound/call-provider";
import {
  ProviderCircuitBreaker,
  openProvidersAcrossBreakers,
  sharedProviderBreaker,
} from "../common/outbound/provider-circuit-breaker";
import { providerCheck } from "./dependency-checks";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const now = () => NOW;

const descriptor = (provider: string) => ({
  provider,
  timeoutMs: 50,
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
  classify: () => "retryable" as const,
});

describe("readiness sees breakers the application actually uses", () => {
  it("a private breaker's open circuit is visible to the process-level view", () => {
    const privateBreaker = new ProviderCircuitBreaker(1, 60_000);
    privateBreaker.recordFailure("razorpay-orders", NOW);

    // The bug in one line: the shared instance knows nothing about it.
    expect(sharedProviderBreaker.openProviders(NOW + 1_000)).not.toContain("razorpay-orders");
    // The aggregate does.
    expect(openProvidersAcrossBreakers(NOW + 1_000)).toContain("razorpay-orders");
  });

  it("MEASURED: a real callProvider failure through a private breaker reaches providerCheck", async () => {
    const privateBreaker = new ProviderCircuitBreaker(1, 60_000);

    const result = await callProvider(
      descriptor("razorpay-orders"),
      () => Promise.reject(new Error("provider down")),
      privateBreaker,
      () => 0,
    );
    expect(result.ok).toBe(false);

    const outcome = await providerCheck(
      ["razorpay"],
      (t) => openProvidersAcrossBreakers(t),
      now,
    ).run();

    expect(outcome.state).toBe("down");
    expect(outcome.detail).toContain("razorpay");
  });

  it("an operator's plain provider name matches the descriptor's qualified key", async () => {
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("razorpay-orders", NOW);
    breaker.recordFailure("webhook:412", NOW);

    const razorpay = await providerCheck(
      ["razorpay"],
      (t) => openProvidersAcrossBreakers(t),
      now,
    ).run();
    const webhooks = await providerCheck(
      ["webhook"],
      (t) => openProvidersAcrossBreakers(t),
      now,
    ).run();

    expect(razorpay.state).toBe("down");
    expect(webhooks.state).toBe("down");
  });

  /**
   * Provider keys below are unique per test on purpose. The registry is
   * PROCESS-level by design, so a breaker opened by an earlier test is still
   * open for a later one — which is exactly the property that makes readiness
   * work, and exactly the property that makes a shared key a false negative.
   */
  it("does not match a provider that merely shares a prefix with no separator", async () => {
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("acmepayments", NOW);

    const outcome = await providerCheck(
      ["acmepay"],
      (t) => openProvidersAcrossBreakers(t),
      now,
    ).run();

    // "acmepayments" is a different provider, not an operation of "acmepay".
    expect(outcome.state).toBe("up");
  });

  it("still reports up when the required provider's circuit is closed", async () => {
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("slack-webhooks", NOW);

    const outcome = await providerCheck(
      ["stripe"],
      (t) => openProvidersAcrossBreakers(t),
      now,
    ).run();

    expect(outcome.state).toBe("up");
  });

  it("a breaker whose cooldown has elapsed drops out of the aggregate without half-opening", () => {
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("cooldown-probe", NOW);

    expect(openProvidersAcrossBreakers(NOW + 1_000)).toContain("cooldown-probe");
    expect(openProvidersAcrossBreakers(NOW + 60_001)).not.toContain("cooldown-probe");
    // Reading the aggregate must not consume the half-open probe slot.
    expect(breaker.check("cooldown-probe", NOW + 1_000).open).toBe(true);
  });
});
