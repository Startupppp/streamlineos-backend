const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 2 * 60_000;

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
  ) {}

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
