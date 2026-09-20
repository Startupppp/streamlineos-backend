import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
} from "ai";
import { HttpException } from "@nestjs/common";
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
import type { AuditService } from "../../../../common/audit/audit.service";
import {
  makeReservationHandle,
  settleStream,
  type ReservationHandle,
} from "./ai-gateway-stream-credit";
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
  messages?: ModelMessage[];
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet>;
  temperature?: number;
  model?: LanguageModel;
  modelId?: string;
  onCompleted?: (result: { text: string; promptTokens: number; completionTokens: number }) => Promise<void>;
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

interface StepUsageCarrier {
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
}

export function sumStepUsage(
  steps: readonly StepUsageCarrier[] | undefined,
): { promptTokens: number; completionTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const step of steps ?? []) {
    promptTokens += step.usage?.inputTokens ?? 0;
    completionTokens += step.usage?.outputTokens ?? 0;
  }
  return { promptTokens, completionTokens };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** The per-tenant sibling of a provider breaker key. */
export function tenantBreakerKey(key: string, orgId: string): string {
  return `${key}:org:${orgId}`;
}

export type BreakerAttribution = "provider" | "tenant" | "request";

export function breakerAttribution(error: unknown): BreakerAttribution {
  if (error instanceof HttpException) return "request";
  const kind = classifyLlmError(error);
  if (kind === "fatal") return "request";
  if (kind === "rate_limit") return "tenant";
  return "provider";
}

export class AiGatewayStreamHelper {
  private readonly breakers = new Map<string, AiStreamBreaker>();

  constructor(
    private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
    private readonly redis: AiStreamBreakerRedis | null = null,
    private readonly audit: Pick<AuditService, "log"> | null = null,
  ) {}

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

    let reservation: ReservationHandle;
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
        reservation = makeReservationHandle(reserved.reservationId, actor.orgId, this.ledger, feature);
      } catch (error) {
        releaseConcurrency();
        call.finish("quota_exceeded");
        throw error;
      }
    } else {
      reservation = makeReservationHandle(0, actor.orgId, this.ledger, feature);
    }

    let streamCompleted = false;

    try {
      const selection = resolveAiStreamModel(opts.tier);
      const model = opts.model ?? selection.model;
      const modelId = opts.modelId ?? selection.modelId;

      const auditSettlement = (
        outcome: "ok" | "cancelled",
        promptTokens: number,
        completionTokens: number,
      ): void => {
        this.audit?.log({
          action: "ai.stream",
          ...(actor.userId
            ? { userId: actor.userId }
            : { systemActor: "ai.gateway.unattended-stream" }),
          orgId: actor.orgId,
          metadata: {
            feature,
            model: modelId,
            correlationId: call.correlationId,
            promptTokens,
            completionTokens,
            outcome,
          },
        });
      };

      call.providerOpened();
      const stream = streamText({
        model,
        messages: opts.messages ?? [{ role: "user", content: prompt.user }],
        system: prompt.system,
        maxOutputTokens: opts.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
        maxRetries: resolveLlmRetryPolicy().maxRetriesPerModel,
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        ...(opts.stopWhen !== undefined ? { stopWhen: opts.stopWhen } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(signal !== undefined ? { abortSignal: signal } : {}),
        onChunk: () => call.firstToken(),
        onAbort: (event?: { steps?: readonly StepUsageCarrier[] }) => {
          if (streamCompleted) return;
          streamCompleted = true;
          releaseConcurrency();
          const partial = sumStepUsage(event?.steps);
          call.finish("cancelled", {
            model: modelId,
            promptTokens: partial.promptTokens,
            completionTokens: partial.completionTokens,
          });
          if (partial.promptTokens === 0 && partial.completionTokens === 0) {
            reservation.release("stream_aborted_no_settle");
            return;
          }
          if (!reservation.markSettled()) return;
          void settleStream(this.ledger, this.usageSvc, {
            reservationId: reservation.reservationId,
            model: modelId,
            promptTokens: partial.promptTokens,
            completionTokens: partial.completionTokens,
            orgId: actor.orgId,
            userId: actor.userId,
            feature,
            appOverheadMs: 0,
            outcome: "cancelled",
          })
            .then(() =>
              auditSettlement("cancelled", partial.promptTokens, partial.completionTokens),
            )
            .catch((err: unknown) => {
            logger.error("Failed to settle a cancelled AI stream", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              feature,
              orgId: actor.orgId,
              reservationId: reservation.reservationId,
            });
          });
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
          reservation.release("stream_error");
        },
        onFinish: async ({ text, usage }) => {
          if (streamCompleted) return;
          streamCompleted = true;
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
          if (!reservation.markSettled()) return;
          try {
            await settleStream(this.ledger, this.usageSvc, {
              reservationId: reservation.reservationId,
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
            auditSettlement("ok", promptTokens, completionTokens);
          } catch (err) {
            logger.error("Failed to settle AI text stream", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              feature,
              orgId: actor.orgId,
              reservationId: reservation.reservationId,
            });
          }
          if (!opts.onCompleted) return;
          try {
            await opts.onCompleted({ text, promptTokens, completionTokens });
          } catch (err) {
            logger.error("AI stream completion hook failed", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              feature,
              orgId: actor.orgId,
            });
          }
        },
      });

      void Promise.resolve(stream.finishReason).catch(() => {
        releaseConcurrency();
        reservation.release("stream_aborted_no_settle");
        call.finish(signal?.aborted === true ? "cancelled" : "provider_unavailable");
      });

      return { stream, model: modelId, correlationId: call.correlationId };
    } catch (error) {
      recordProviderFailure(error);
      releaseConcurrency();
      reservation.release("stream_setup_error");
      call.finish("error");
      throw error;
    }
  }
}
