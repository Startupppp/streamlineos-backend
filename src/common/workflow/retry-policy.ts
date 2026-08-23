/**
 * What to do with a run that just failed.
 *
 * Pure, because this is the part that decides whether work is abandoned. A rule
 * that silently gives up one attempt early, or never gives up at all, is the
 * kind of defect that only shows up in production at 3am — so it is testable
 * without a database, a clock or a queue.
 */

export const BASE_BACKOFF_MS = 10_000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

export type FailureDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly runAfter: Date }
  | { readonly kind: "dead-letter"; readonly attempt: number };

export interface FailureInput {
  /** Attempts already made, including the one that just failed. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly now: Date;
  /** 0..1. Injected so a test gets a deterministic delay. */
  readonly jitter?: number;
}

/**
 * Exponential backoff with jitter, capped.
 *
 * Jitter matters more than the curve: without it, a provider outage that fails a
 * thousand runs at once retries all thousand in lockstep and knocks the provider
 * over again the moment it recovers.
 */
export function backoffMs(attempt: number, jitter = Math.random()): number {
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  // Full jitter across the window rather than a small wobble around the peak.
  return Math.round(capped * (0.5 + jitter * 0.5));
}

export function decideAfterFailure(input: FailureInput): FailureDecision {
  const attempt = input.attempt;

  if (attempt >= input.maxAttempts) return { kind: "dead-letter", attempt };

  return {
    kind: "retry",
    attempt,
    runAfter: new Date(input.now.getTime() + backoffMs(attempt, input.jitter)),
  };
}

/**
 * How long a worker may hold a run before another may take it.
 *
 * Long enough that a slow step is not stolen mid-flight, short enough that a
 * killed process does not strand its run for long. The runner extends nothing:
 * a step that outlives the lease is a step that should have been split.
 */
export const LEASE_MS = 5 * 60 * 1000;

export function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + LEASE_MS);
}
