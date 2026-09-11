import {
  decryptSecret,
  isEncryptedSecret,
} from "../../../common/security/secret-encryption.util";
import type {
  ProviderCallResult,
  ProviderDescriptor,
} from "../../../common/outbound/call-provider";
import { WEBHOOK_RESPONSE_BODY_LIMIT } from "../dto/webhook.schemas";

/**
 * The policy of one outbound webhook delivery: how long it may take, how its
 * failures are told apart, which secret signs it, and what its log row says
 * afterwards. Nothing here touches the database or the network; that is
 * `WebhooksDispatchService`'s half.
 */
export const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 1_000;
const WEBHOOK_MAX_DELAY_MS = 30_000;

export class WebhookTerminalStatusError extends Error {
  readonly statusCode: number;
  constructor(status: number, body: string) {
    super(`Endpoint responded with ${status}: ${body.slice(0, 200)}`);
    this.statusCode = status;
    this.name = "WebhookTerminalStatusError";
  }
}

export function classifyWebhookError(err: unknown): "terminal" | "retryable" {
  if (err instanceof WebhookTerminalStatusError) return "terminal";
  return "retryable";
}

/** The retry and timeout policy each endpoint is called under. */
export function webhookDescriptor(endpointId: number): ProviderDescriptor {
  return {
    provider: `webhook:${endpointId}`,
    timeoutMs: WEBHOOK_TIMEOUT_MS,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    baseDelayMs: WEBHOOK_BASE_DELAY_MS,
    maxDelayMs: WEBHOOK_MAX_DELAY_MS,
    classify: classifyWebhookError,
  };
}

/**
 * Secrets are encrypted at rest from 2026-08-11. Rows created before that are
 * still plaintext, so read through this rather than assuming either form —
 * signing with the wrong value silently breaks every consumer's verification.
 */
export function readSigningSecret(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

export interface DeliveryTarget {
  id: number;
  url: string;
  secret: string;
}

export interface FetchedResponse {
  status: number;
  body: string;
}

export function logFromResult(
  result: ProviderCallResult<FetchedResponse>,
): { statusCode: number | null; responseBody: string | null; success: boolean } {
  if (result.ok)
    return {
      statusCode: result.value.status,
      responseBody: result.value.body.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT),
      success: true,
    };

  if (result.kind === "terminal") {
    const err = result.error;
    return {
      statusCode: err instanceof WebhookTerminalStatusError ? err.statusCode : null,
      responseBody: err.message.slice(0, WEBHOOK_RESPONSE_BODY_LIMIT),
      success: false,
    };
  }

  if (result.kind === "dead-lettered")
    return {
      statusCode: null,
      responseBody: `Dead after ${result.attempts} attempts: ${result.error.message}`.slice(
        0,
        WEBHOOK_RESPONSE_BODY_LIMIT,
      ),
      success: false,
    };

  return {
    statusCode: null,
    responseBody: `Circuit open for endpoint; retry after ${result.retryAfterMs}ms`,
    success: false,
  };
}
