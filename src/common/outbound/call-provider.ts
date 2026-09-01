import { ProviderCircuitBreaker, sharedProviderBreaker } from "./provider-circuit-breaker";

export type FailureClass = "retryable" | "terminal";

export interface ProviderDescriptor {
  provider: string;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify: (error: unknown) => FailureClass;
}

export type ProviderCallResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; kind: "terminal"; error: Error; attempts: number }
  | { ok: false; kind: "dead-lettered"; error: Error; attempts: number }
  | { ok: false; kind: "circuit-open"; retryAfterMs: number; attempts: number };

export class ProviderTimeoutError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider} timed out after ${ms}ms`);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Full-jitter backoff: uniform random in [half, full] of the capped window.
 *
 * Full jitter (rather than a small wobble around the peak) means a provider-wide
 * failure that causes many concurrent callers to back off will spread their retries
 * uniformly across the entire window, eliminating the thundering-herd on recovery.
 *
 * `random` is injected for deterministic testing.
 */
export function providerBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.round(capped * (0.5 + random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function wrapWithTimeout<T>(fn: () => Promise<T>, ms: number, provider: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProviderTimeoutError(provider, ms)),
      ms,
    );
    fn().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * One shared outbound-provider seam.
 *
 * Wraps `fn` with:
 *   - timeout: fires `ProviderTimeoutError` at descriptor.timeoutMs
 *   - circuit breaker: checks before each attempt, opens after threshold failures
 *   - retry with full-jitter exponential backoff, bounded by descriptor.maxAttempts
 *   - failure classification: caller's `descriptor.classify` decides retryable vs terminal
 *
 * Returns a discriminated union — never throws on provider failure. The caller is
 * responsible for converting the result into a domain exception.
 *
 * Circuit breaker is process-local by default (see ProviderCircuitBreaker for rationale).
 * Pass an explicit `breaker` to scope it differently (e.g. per tenant in tests).
 */
export async function callProvider<T>(
  descriptor: ProviderDescriptor,
  fn: () => Promise<T>,
  breaker: ProviderCircuitBreaker = sharedProviderBreaker,
  random: () => number = Math.random,
): Promise<ProviderCallResult<T>> {
  let lastError: Error = new Error(`${descriptor.provider}: no attempts made`);

  for (let attempt = 1; attempt <= descriptor.maxAttempts; attempt++) {
    const decision = breaker.check(descriptor.provider, Date.now());
    if (decision.open)
      return { ok: false, kind: "circuit-open", retryAfterMs: decision.retryAfterMs, attempts: attempt };

    try {
      const value = await wrapWithTimeout(fn, descriptor.timeoutMs, descriptor.provider);
      breaker.recordSuccess(descriptor.provider);
      return { ok: true, value, attempts: attempt };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const cls = descriptor.classify(err);
      breaker.recordFailure(descriptor.provider, Date.now());

      if (cls === "terminal")
        return { ok: false, kind: "terminal", error, attempts: attempt };

      if (attempt < descriptor.maxAttempts)
        await sleep(providerBackoffMs(attempt, descriptor.baseDelayMs, descriptor.maxDelayMs, random));
    }
  }

  return { ok: false, kind: "dead-lettered", error: lastError, attempts: descriptor.maxAttempts };
}
