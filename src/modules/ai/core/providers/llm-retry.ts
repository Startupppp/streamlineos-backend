export type LlmErrorKind = "rate_limit" | "overloaded" | "transient" | "fatal";

export interface LlmRetryPolicy {
  maxRetriesPerModel: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_LLM_RETRY_POLICY: LlmRetryPolicy = {
  maxRetriesPerModel: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export function resolveLlmRetryPolicy(env: NodeJS.ProcessEnv = process.env): LlmRetryPolicy {
  const raw = Number(env.AI_LLM_MAX_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_LLM_RETRY_POLICY;
  return { ...DEFAULT_LLM_RETRY_POLICY, maxRetriesPerModel: Math.min(Math.trunc(raw), 5) };
}

const RATE_LIMIT_FRAGMENTS = ["rate limit", "rate_limit", "too many requests", "quota", "429"];
const OVERLOADED_FRAGMENTS = ["overloaded", "capacity", "server is busy", "engine is currently"];
const TRANSIENT_FRAGMENTS = [
  "timeout",
  "timed out",
  "econnreset",
  "etimedout",
  "econnrefused",
  "socket hang up",
  "network error",
  "fetch failed",
  "bad gateway",
  "service unavailable",
];
const FATAL_FRAGMENTS = [
  "api key",
  "authentication",
  "unauthorized",
  "permission",
  "context length",
  "maximum context",
  "content policy",
  "invalid_request",
];

function readProperty(source: unknown, key: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  return Reflect.get(source, key);
}

function statusOf(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    for (const key of ["status", "statusCode"]) {
      const value = readProperty(current, key);
      if (typeof value === "number") return value;
    }
    current = readProperty(current, "cause");
  }
  return null;
}

function messageOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const message = readProperty(current, "message");
    if (typeof message === "string") parts.push(message);
    const code = readProperty(current, "code");
    if (typeof code === "string") parts.push(code);
    current = readProperty(current, "cause");
  }
  return parts.join(" ").toLowerCase();
}

/**
 * A 400/401/403 will fail identically on a fallback model, so retrying or
 * switching only spends latency; everything else is worth another attempt.
 */
export function classifyLlmError(error: unknown): LlmErrorKind {
  const status = statusOf(error);
  if (status === 429) return "rate_limit";
  if (status === 503) return "overloaded";
  if (status !== null) {
    if (status === 408 || status === 409 || status >= 500) return "transient";
    if (status >= 400) return "fatal";
  }

  const message = messageOf(error);
  if (RATE_LIMIT_FRAGMENTS.some((f) => message.includes(f))) return "rate_limit";
  if (OVERLOADED_FRAGMENTS.some((f) => message.includes(f))) return "overloaded";
  if (FATAL_FRAGMENTS.some((f) => message.includes(f))) return "fatal";
  if (TRANSIENT_FRAGMENTS.some((f) => message.includes(f))) return "transient";
  return "transient";
}

export function isAuthError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 403) return true;
  const message = messageOf(error);
  return ["api key", "authentication", "unauthorized"].some((f) => message.includes(f));
}

/** Honours a provider-supplied `Retry-After` (seconds) over the computed backoff. */
export function retryAfterMs(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const headers = readProperty(current, "headers");
    if (headers !== null && typeof headers === "object") {
      for (const key of ["retry-after", "Retry-After", "retry-after-ms"]) {
        const raw = readProperty(headers, key);
        const text = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
        if (text === null) continue;
        const seconds = Number(text);
        if (Number.isFinite(seconds) && seconds >= 0)
          return key === "retry-after-ms" ? seconds : seconds * 1000;
      }
    }
    current = readProperty(current, "cause");
  }
  return null;
}

export function backoffDelayMs(
  attempt: number,
  error: unknown,
  policy: LlmRetryPolicy = DEFAULT_LLM_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const advertised = retryAfterMs(error);
  if (advertised !== null) return Math.min(advertised, policy.maxDelayMs);

  const exponential = policy.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Jitter so a provider-wide 429 does not resynchronise every caller onto one retry instant.
  const jitter = capped * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}
