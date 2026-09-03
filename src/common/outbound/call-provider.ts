import { ProviderCircuitBreaker, sharedProviderBreaker } from "./provider-circuit-breaker";
import { currentSpan, formatTraceparent, withSpan } from "../observability/tracing";
import { getObservabilityContext } from "../observability/observability-context";

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
/**
 * The headers that let a downstream service join this trace.
 *
 * W3C `traceparent` for anything that speaks it, and `x-correlation-id` for the
 * far commoner case of a service that only echoes an opaque request id back into
 * its own logs — which is exactly what makes a provider's support ticket
 * joinable to ours. Empty when there is nothing ambient to propagate, so a
 * background call sends no misleading header.
 *
 * Header names only, never a credential: a caller merges these into whatever
 * authentication headers it already builds.
 */
export function outboundTraceHeaders(): Record<string, string> {
  const span = currentSpan();
  const correlationId = getObservabilityContext()?.correlationId;
  return {
    ...(span ? { traceparent: formatTraceparent(span) } : {}),
    ...(correlationId ? { "x-correlation-id": correlationId } : {}),
  };
}

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
      /**
       * One span per attempt, not per call: a call that succeeded on its third
       * try after two timeouts and a call that succeeded immediately are the
       * same single span otherwise, and the retries — the thing worth seeing —
       * are invisible. The span is also what `outboundTraceHeaders` reads, so
       * the header the provider receives names this attempt.
       */
      const value = await withSpan(
        `provider.${descriptor.provider}`,
        () => wrapWithTimeout(fn, descriptor.timeoutMs, descriptor.provider),
        { attributes: { "provider.name": descriptor.provider, "provider.attempt": attempt } },
      );
      breaker.recordSuccess(descriptor.provider);
      return { ok: true, value, attempts: attempt };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const cls = descriptor.classify(err);

      /**
       * Only a RETRYABLE failure is evidence about the provider. A terminal
       * failure is the caller's own classification of "the provider answered and
       * the request was wrong" — a 4xx — which proves the provider is reachable
       * and healthy. Counting it opened a circuit whose key is shared by every
       * other caller of the same provider: `razorpay-orders` is one process-wide
       * string on one module-level breaker, so five 400s from one tenant's
       * mis-saved credential returned `circuit-open` to every other tenant's
       * checkout for the full 120s cooldown, without a single further call to
       * Razorpay.
       *
       * The counter is left untouched rather than reset: a 4xx is not evidence of
       * recovery either, and calling `recordSuccess` here would let interleaved
       * bad requests keep clearing a genuine outage's failure count. A terminal
       * failure is also never retried (below), so declining to count it adds no
       * load — the provider still sees exactly one request per call.
       */
      if (cls === "retryable") breaker.recordFailure(descriptor.provider, Date.now());

      if (cls === "terminal")
        return { ok: false, kind: "terminal", error, attempts: attempt };

      if (attempt < descriptor.maxAttempts)
        await sleep(providerBackoffMs(attempt, descriptor.baseDelayMs, descriptor.maxDelayMs, random));
    }
  }

  return { ok: false, kind: "dead-lettered", error: lastError, attempts: descriptor.maxAttempts };
}
