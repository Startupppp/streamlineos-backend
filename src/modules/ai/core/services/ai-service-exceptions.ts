import { RequestTimeoutException, ServiceUnavailableException } from "@nestjs/common";

/**
 * The two 503s an AI surface can raise mean genuinely different things to the
 * person waiting, and until now they were distinguishable only by matching the
 * message text — which the frontend rules forbid and which breaks the first time
 * anyone rewords a string.
 *
 * Shaped like `InsufficientAiCreditsException`'s 402: an object body carrying a
 * `code`, which `AllExceptionsFilter` lifts onto the response envelope. Both
 * still extend `ServiceUnavailableException`, so the `instanceof` checks already
 * in the gateway and the controllers keep working and `.message` keeps reading
 * back the same string.
 */
export const AI_PROVIDER_UNAVAILABLE_CODE = "AI_PROVIDER_UNAVAILABLE";
export const AI_CONCURRENCY_LIMIT_CODE = "AI_CONCURRENCY_LIMIT";

const PROVIDER_UNAVAILABLE_DEFAULT = "AI provider is temporarily unavailable";
const CONCURRENCY_LIMIT_DEFAULT = "Too many concurrent AI requests for this organization";

/** The provider is failing or the breaker is open: try again later. */
export class AiProviderUnavailableException extends ServiceUnavailableException {
  constructor(message: string = PROVIDER_UNAVAILABLE_DEFAULT) {
    super({
      code: AI_PROVIDER_UNAVAILABLE_CODE,
      message: message.trim() ? message : PROVIDER_UNAVAILABLE_DEFAULT,
    });
  }
}

/** We are at capacity for this organisation: the same request will work shortly. */
export class AiConcurrencyLimitException extends ServiceUnavailableException {
  constructor(message: string = CONCURRENCY_LIMIT_DEFAULT) {
    super({
      code: AI_CONCURRENCY_LIMIT_CODE,
      message: message.trim() ? message : CONCURRENCY_LIMIT_DEFAULT,
    });
  }
}

export const AI_REQUEST_CANCELLED_CODE = "AI_REQUEST_CANCELLED";

const REQUEST_CANCELLED_DEFAULT = "AI request was cancelled before it completed";

/**
 * The caller hung up or the deadline fired. Distinct from a provider fault on
 * purpose: nothing failed, so this must never feed the circuit breaker and must
 * never settle a full charge.
 */
export class AiRequestCancelledException extends RequestTimeoutException {
  constructor(message: string = REQUEST_CANCELLED_DEFAULT) {
    super({
      code: AI_REQUEST_CANCELLED_CODE,
      message: message.trim() ? message : REQUEST_CANCELLED_DEFAULT,
    });
  }
}
