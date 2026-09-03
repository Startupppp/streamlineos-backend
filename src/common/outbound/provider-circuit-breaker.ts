const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 2 * 60_000;

/**
 * Registered on construction so `openProvidersAcrossBreakers` can see every
 * breaker without each one having to remember to announce itself.
 *
 * A strong Set, deliberately. Breakers are process singletons — one per
 * injectable provider, created at boot and never discarded — so the set is
 * bounded by the number of outbound integrations, not by traffic. A weak,
 * iterable registry would need `WeakRef` plus a `FinalizationRegistry` to buy
 * nothing at this cardinality. Do not start constructing breakers per request.
 */
const BREAKERS = new Set<ProviderCircuitBreaker>();

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface BreakerDecision {
  open: boolean;
  retryAfterMs: number;
}

/**
 * Per-provider in-process circuit breaker for outbound HTTP calls.
 *
 * State is deliberately process-local. A circuit breaker is a protection heuristic,
 * not a correctness mechanism — the caller's durable state (outbox row, job record)
 * is the source of truth. Sharing state through Redis would add a network round trip
 * to the hot path to save a handful of duplicate probes across nodes; the cost outweighs
 * the benefit at current scale. Revisit when a multi-node deployment shows per-node probes
 * actually degrading a provider during recovery.
 *
 * Scope is per provider key, not per tenant. A provider outage is provider-wide;
 * tenant-scoped breakers would let one tenant's traffic keep probing a downed provider.
 */
export class ProviderCircuitBreaker {
  private readonly state = new Map<string, BreakerState>();

  constructor(
    private readonly threshold: number = DEFAULT_THRESHOLD,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {
    // Every breaker joins the process-level view. Readiness read only
    // `sharedProviderBreaker`, which no production call site uses, so the probe
    // could never report a provider down; see `openProvidersAcrossBreakers`.
    BREAKERS.add(this);
  }

  /**
   * `now` is passed in (rather than read here) so callers control the clock and
   * the cooldown is testable without fake timers.
   *
   * Half-open: the first attempt after the cooldown passes through as a probe.
   * The counter is left intact so a failed probe re-opens immediately rather than
   * needing another full threshold of failures.
   */
  check(provider: string, now: number): BreakerDecision {
    const entry = this.state.get(provider);
    if (!entry?.openedAt) return { open: false, retryAfterMs: 0 };

    const elapsed = now - entry.openedAt;
    if (elapsed >= this.cooldownMs) {
      entry.openedAt = null;
      return { open: false, retryAfterMs: 0 };
    }
    return { open: true, retryAfterMs: this.cooldownMs - elapsed };
  }

  /**
   * Providers whose circuit is open right now, without changing anything.
   *
   * `check` half-opens a breaker whose cooldown has elapsed, which is correct for
   * a caller about to make a call and wrong for a health probe: a probe that
   * consumed the half-open slot would spend the recovery attempt on itself.
   */
  openProviders(now: number): readonly string[] {
    const open: string[] = [];
    for (const [provider, entry] of this.state)
      if (entry.openedAt !== null && now - entry.openedAt < this.cooldownMs) open.push(provider);
    return open;
  }

  recordSuccess(provider: string): void {
    this.state.delete(provider);
  }

  recordFailure(provider: string, now: number): boolean {
    const entry = this.state.get(provider) ?? { consecutiveFailures: 0, openedAt: null };
    entry.consecutiveFailures += 1;
    const shouldOpen = entry.consecutiveFailures >= this.threshold && entry.openedAt === null;
    if (shouldOpen) entry.openedAt = now;
    this.state.set(provider, entry);
    return shouldOpen;
  }
}

export const sharedProviderBreaker = new ProviderCircuitBreaker();

/**
 * Every provider whose circuit is open right now, across every breaker in this
 * process.
 *
 * `sharedProviderBreaker` is only the DEFAULT argument of `callProvider`, and
 * all three production call sites override it with a private instance
 * (`razorpay.adapter.ts`, `webhooks-dispatch.service.ts`,
 * `projects-webhooks-dispatch.service.ts`). Readiness therefore read a map that
 * was permanently empty and could never report a provider down — it rendered
 * and never denied.
 *
 * Aggregating rather than forcing every call site onto one instance keeps the
 * per-service breaker (a webhook dispatcher's failures are its own) while making
 * the health probe see all of them. A breaker added later is visible with no
 * further wiring, which is the property whose absence caused this.
 *
 * `openProviders` is used deliberately over `check`: it does not half-open a
 * breaker whose cooldown has elapsed, so a probe never spends the recovery
 * attempt on itself.
 */
export function openProvidersAcrossBreakers(now: number): readonly string[] {
  const open = new Set<string>();
  for (const breaker of BREAKERS)
    for (const provider of breaker.openProviders(now)) open.add(provider);
  return [...open];
}
