import { logger } from "../logger/logger.service";
import { checkWebhookUrl } from "../security/ssrf-guard";

export type OutboundOutcome = "ok" | "timeout" | "ssrf-blocked" | "network-error";

export interface OutboundRequestInit extends Omit<RequestInit, "signal" | "redirect"> {
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export class OutboundRequestError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly outcome: Exclude<OutboundOutcome, "ok">,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OutboundRequestError";
  }
}

export async function outboundRequest(
  url: string,
  init: OutboundRequestInit,
): Promise<Response> {
  const { provider, timeoutMs, signal: callerSignal, ...fetchInit } = init;

  const check = await checkWebhookUrl(url);
  if (!check.allowed) {
    logger.warn("OUTBOUND_BLOCKED", { provider, reason: check.reason });
    throw new OutboundRequestError(
      `SSRF guard rejected outbound request: ${check.reason}`,
      provider,
      "ssrf-blocked",
    );
  }

  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (callerSignal !== undefined) signals.push(callerSignal);
  const combined = AbortSignal.any(signals);

  const start = performance.now();

  try {
    const response = await fetch(url, {
      ...fetchInit,
      redirect: "error",
      signal: combined,
    });
    const durationMs = Math.round(performance.now() - start);
    logger.info("OUTBOUND_OK", { provider, status: response.status, durationMs });
    return response;
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      logger.warn("OUTBOUND_TIMEOUT", { provider, timeoutMs, durationMs });
      throw new OutboundRequestError(
        `${provider} timed out after ${timeoutMs}ms`,
        provider,
        "timeout",
        error,
      );
    }
    logger.error("OUTBOUND_ERROR", { provider, durationMs, error });
    throw new OutboundRequestError(
      `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`,
      provider,
      "network-error",
      error,
    );
  }
}
