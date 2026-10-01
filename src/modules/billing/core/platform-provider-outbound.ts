import { logger } from "../../../common/logger/logger.service";
import {
  ProviderTimeoutError,
  callProvider,
  type FailureClass,
} from "../../../common/outbound/call-provider";
import {
  ProviderCircuitBreaker,
  sharedProviderBreaker,
} from "../../../common/outbound/provider-circuit-breaker";

type ProviderCallSafety =
  | { readonly kind: "read" }
  | { readonly kind: "write"; readonly idempotencyKey?: string };

export interface PlatformProviderCall {
  readonly provider: string;
  readonly operation: string;
  readonly safety: ProviderCallSafety;
  readonly timeoutMs: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export class PlatformProviderHttpError extends Error {
  constructor(
    readonly status: number,
    internalMessage = `Provider returned HTTP ${status}`,
  ) {
    super(internalMessage);
    this.name = "PlatformProviderHttpError";
  }
}

export class PlatformProviderCallError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly kind: "terminal" | "dead-lettered" | "circuit-open",
    readonly attempts: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider} ${operation} is temporarily unavailable`);
    this.name = "PlatformProviderCallError";
  }
}

function classifyProviderFailure(error: unknown): FailureClass {
  if (error instanceof ProviderTimeoutError) return "retryable";
  if (!(error instanceof PlatformProviderHttpError)) return "retryable";
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    ? "retryable"
    : "terminal";
}

function maxAttemptsFor(safety: ProviderCallSafety): number {
  if (safety.kind === "read") return 3;
  return safety.idempotencyKey?.trim() ? 3 : 1;
}

export async function callPlatformProvider<T>(
  call: PlatformProviderCall,
  operation: () => Promise<T>,
  breaker: ProviderCircuitBreaker = sharedProviderBreaker,
): Promise<{ readonly value: T; readonly attempts: number }> {
  const result = await callProvider(
    {
      provider: `${call.provider}-${call.operation}`,
      timeoutMs: call.timeoutMs,
      maxAttempts: maxAttemptsFor(call.safety),
      baseDelayMs: call.baseDelayMs ?? 200,
      maxDelayMs: call.maxDelayMs ?? 2_000,
      classify: classifyProviderFailure,
    },
    operation,
    breaker,
  );

  if (result.ok) {
    logger.info("PLATFORM_PROVIDER_CALL_SUCCEEDED", {
      provider: call.provider,
      operation: call.operation,
      attempts: result.attempts,
    });
    return { value: result.value, attempts: result.attempts };
  }

  logger.warn("PLATFORM_PROVIDER_CALL_FAILED", {
    provider: call.provider,
    operation: call.operation,
    kind: result.kind,
    attempts: result.attempts,
    ...(result.kind === "circuit-open" ? { retryAfterMs: result.retryAfterMs } : {}),
    ...(result.kind !== "circuit-open" && result.error instanceof PlatformProviderHttpError
      ? { status: result.error.status }
      : {}),
  });

  throw new PlatformProviderCallError(
    call.provider,
    call.operation,
    result.kind,
    result.attempts,
    result.kind === "circuit-open" ? result.retryAfterMs : undefined,
  );
}
