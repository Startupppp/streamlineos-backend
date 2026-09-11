import { streamText, type ToolSet } from "ai";
import { logger } from "../../../../common/logger/logger.service";
import { resolveAiStreamModel } from "./ai-stream-model";
import { classifyLlmError, resolveLlmRetryPolicy } from "../providers/llm-retry";
import { redactSensitiveData } from "../redaction.util";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { AiCallMetrics } from "../telemetry/ai-call-metrics";
import { AiStreamBreaker, type AiStreamBreakerRedis } from "../streaming/ai-stream-breaker";
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
import { aiReservationIdempotencyKey } from "../streaming/ai-request-abort";
import { AiUsageService } from "../services/ai-usage.service";
import { settleStream } from "./ai-gateway-stream-credit";
import { type AiCreditLedger } from "./credit-ledger.interface";
import type { AiInvokeActor, AiInvokePrompt } from "./ai-gateway.types";
import {
  AiConcurrencyLimitException,
  AiRequestCancelledException,
} from "../services/ai-service-exceptions";

export interface AiStreamTextOpts {
  tier?: "fast" | "standard";
  actor: AiInvokeActor;
  feature: string;
  prompt: AiInvokePrompt;
  maxTokens?: number;
  charge?: boolean;
  redact?: boolean;
  signal?: AbortSignal;
  /** Groups surfaces that share a provider fate; defaults to one breaker for all streaming. */
  breakerKey?: string;
}

export interface AiTextStream {
  stream: ReturnType<typeof streamText<ToolSet>>;
  model: string;
  correlationId: string;
}

const DEFAULT_STREAM_MAX_TOKENS = 1_024;
const DEFAULT_BREAKER_KEY = "stream";
const BREAKER_MESSAGE = "AI assistant is temporarily unavailable";
const TENANT_BREAKER_MESSAGE =
  "This organization has exceeded its AI rate limit — try again shortly";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** The per-tenant sibling of a provider breaker key. */
export function tenantBreakerKey(key: string, orgId: string): string {
  return `${key}:org:${orgId}`;
}

export type BreakerAttribution = "provider" | "tenant" | "request";

/**
 * Who a failed stream is EVIDENCE against.
 *
 * The breaker used to count every non-abort error as provider ill-health on one
 * globally shared key, which made it two things it should never be. A 400 —
 * a malformed prompt, an over-length context, a content-policy refusal — is a
 * verdict on the REQUEST: it will fail identically on a fallback model, so
 * `llm-retry` already refuses to retry it, and counting it as provider illness
 * meant five bad prompts from one tenant denied AI to every other tenant in the
 * deployment for 30 s. A 429 is a verdict on the TENANT's burn rate, not on the
 * provider's health, so it opens that tenant's breaker alone. Only 5xx and
 * unclassifiable faults are evidence the provider itself is unwell.
 */
export function breakerAttribution(error: unknown): BreakerAttribution {
  const kind = classifyLlmError(error);
  if (kind === "fatal") return "request";
  if (kind === "rate_limit") return "tenant";
  return "provider";
}

/**
 * The streaming sibling of `invokeText`. A streamed turn has the same
 * obligations as a buffered one — breaker, concurrency slot, atomic reservation
 * before the paid call, token-metered settlement after — but they land on
 * different callbacks, so hand-rolling them per surface is how one route ends up
 * settling twice and another leaves a reservation stranded. Every non-chat
 * streaming surface goes through here.
 */
export class AiGatewayStreamHelper {
  private readonly breakers = new Map<string, AiStreamBreaker>();

  constructor(
    private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
    private readonly redis: AiStreamBreakerRedis | null = null,
  ) {}

  /**
   * One instance per key per process. Two instances sharing a Redis key would
   * each keep their own local counter, so the breaker would need twice the
   * failures to trip whenever Redis is unavailable — which is exactly when it
   * matters.
   */
  breakerFor(key: string, unavailableMessage: string = BREAKER_MESSAGE): AiStreamBreaker {
    const existing = this.breakers.get(key);
    if (existing) return existing;
    const created = new AiStreamBreaker({
      key,
      unavailableMessage,
      redis: this.redis,
    });
    this.breakers.set(key, created);
    return created;
  }

  async run(opts: AiStreamTextOpts): Promise<AiTextStream> {
    const { actor, feature, signal, charge = true, redact = true } = opts;
    const call = AiCallMetrics.begin({ feature, tier: opts.tier ?? "chat", orgId: actor.orgId });
    const breakerKey = opts.breakerKey ?? DEFAULT_BREAKER_KEY;
    const breaker = this.breakerFor(breakerKey);
    const tenantBreaker = this.breakerFor(
      tenantBreakerKey(breakerKey, actor.orgId),
      TENANT_BREAKER_MESSAGE,
    );

    await breaker.assertClosed();
    await tenantBreaker.assertClosed();

    const recordProviderFailure = (error: unknown): BreakerAttribution => {
      const attribution = breakerAttribution(error);
      if (attribution === "provider") breaker.recordFailure();
      else if (attribution === "tenant") tenantBreaker.recordFailure();
      return attribution;
    };

    if (signal?.aborted === true) {
      call.finish("cancelled");
      throw new AiRequestCancelledException();
    }

    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    const acquired = await call.queue(() => this.concurrencyLimiter.acquire(actor.orgId));
    if (!acquired) {
      call.finish("concurrency_exceeded");
      throw new AiConcurrencyLimitException();
    }

    let concurrencyReleased = false;
    const releaseConcurrency = (): void => {
      if (concurrencyReleased) return;
      concurrencyReleased = true;
      this.concurrencyLimiter.release(actor.orgId);
    };

    let reservationId = 0;
    if (charge) {
      try {
        const idempotencyKey = aiReservationIdempotencyKey(feature, actor);
        const reserved = await this.ledger.reserve({
          orgId: actor.orgId,
          userId: actor.userId,
          feature,
          credits: getReserveEstimateMilli(feature),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        });
        reservationId = reserved.reservationId;
      } catch (error) {
        releaseConcurrency();
        call.finish("quota_exceeded");
        throw error;
      }
    }

    let resolved = false;
    const releaseReservation = (reason: string): void => {
      if (resolved) return;
      resolved = true;
      if (reservationId === 0) return;
      void this.ledger.release(reservationId, reason, actor.orgId).catch(() => undefined);
    };

    try {
      const { modelId, model } = resolveAiStreamModel(opts.tier);
      call.providerOpened();
      const stream = streamText({
        model,
        messages: [{ role: "user", content: prompt.user }],
        system: prompt.system,
        maxOutputTokens: opts.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
        maxRetries: resolveLlmRetryPolicy().maxRetriesPerModel,
        ...(signal !== undefined ? { abortSignal: signal } : {}),
        onChunk: () => call.firstToken(),
        /**
         * These streams pass no tools, so ai@7.0.51 has no recorded step when a
         * client aborts and `finishReason` REJECTS into the `.catch` below —
         * which is why this surface was never mis-settled. `onAbort` is wired
         * anyway so the two branches of the SDK's `flush`
         * (dist/index.js:9209-9221) have the same handler here as they do in
         * `ChatAssistantService`: the day a tool set is added to a gateway
         * stream, cancellation keeps working instead of silently starting to
         * settle at zero. Both paths are idempotent, so a double notify is a
         * no-op.
         */
        onAbort: () => {
          releaseConcurrency();
          releaseReservation("stream_aborted_no_settle");
          call.finish("cancelled");
        },
        onError: ({ error }) => {
          if (signal?.aborted === true || isAbortError(error)) return;
          const attribution = recordProviderFailure(error);
          logger.warn("AI text stream failed", {
            error: error instanceof Error ? error.message : String(error),
            attribution,
            feature,
            orgId: actor.orgId,
          });
        },
        onFinish: async ({ usage }) => {
          if (resolved) return;
          resolved = true;
          releaseConcurrency();
          breaker.recordSuccess();
          tenantBreaker.recordSuccess();
          const promptTokens = usage?.inputTokens ?? 0;
          const completionTokens = usage?.outputTokens ?? 0;
          const timings = call.finish("ok", {
            model: modelId,
            promptTokens,
            completionTokens,
          });
          try {
            await settleStream(this.ledger, this.usageSvc, {
              reservationId,
              model: modelId,
              promptTokens,
              completionTokens,
              orgId: actor.orgId,
              userId: actor.userId,
              feature,
              ...(timings.ttftMs !== undefined ? { ttftMs: timings.ttftMs } : {}),
              appOverheadMs: timings.overheadMs,
              timings,
            });
          } catch (err) {
            logger.error("Failed to settle AI text stream", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              feature,
              orgId: actor.orgId,
              reservationId,
            });
          }
        },
      });

      void Promise.resolve(stream.finishReason).catch(() => {
        releaseConcurrency();
        releaseReservation("stream_aborted_no_settle");
        call.finish(signal?.aborted === true ? "cancelled" : "provider_unavailable");
      });

      return { stream, model: modelId, correlationId: call.correlationId };
    } catch (error) {
      recordProviderFailure(error);
      releaseConcurrency();
      releaseReservation("stream_setup_error");
      call.finish("error");
      throw error;
    }
  }
}
