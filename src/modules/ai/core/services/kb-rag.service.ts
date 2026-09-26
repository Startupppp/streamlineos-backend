import { HttpException, HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { effectiveRateLimit, rateLimitWindowSecs } from "../../../../common/ratelimit/rate-limit.service";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { streamText, type ToolSet } from "ai";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../gateway/credit-ledger.interface";
import { AiUsageService } from "./ai-usage.service";
import {
  makeReservationHandle,
  settleStream,
  type ReservationHandle,
} from "../gateway/ai-gateway-stream-credit";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { resolveChatModel, resolveChatModelId } from "./chat-assistant-model";
import { logger } from "../../../../common/logger/logger.service";
import { KbRagRetrievalService, type KbAnswerSource } from "./kb-rag-retrieval.service";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { REDIS } from "../../../../common/cache/cache.service";
import { AiStreamBreaker } from "../streaming/ai-stream-breaker";
import { aiReservationIdempotencyKey } from "../streaming/ai-request-abort";
import { resolveLlmRetryPolicy } from "../providers/llm-retry";
import { AiCallMetrics } from "../telemetry/ai-call-metrics";
import { AiConcurrencyLimitException, AiProviderUnavailableException } from "./ai-service-exceptions";

const KB_RAG_STREAM_FEATURE = "kb.public-ask";
const KB_BREAKER_MESSAGE = "AI assistant is temporarily unavailable";
const KB_NO_CONTEXT_ANSWER = "I couldn't find anything related to that in the knowledge base yet.";

export const PUBLIC_KB_ASK_ORG_TIER = "ai:public-kb-ask:org";

const PUBLIC_KB_ASK_ORG_WINDOW_SCRIPT =
  "local hits = redis.call('INCR', KEYS[1]) " +
  "local ttl = redis.call('TTL', KEYS[1]) " +
  "if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end " +
  "return {hits, ttl}";

export function publicKbAskOrgKey(orgId: string): string {
  return `rl:${PUBLIC_KB_ASK_ORG_TIER}:${orgId}`;
}

export interface KbAnswer {
  answer: string;
  sources: KbAnswerSource[];
  hasContext: boolean;
}

export type KbStreamAnswer =
  | { hasContext: false; answer: string; sources: KbAnswerSource[] }
  | {
      hasContext: true;
      stream: ReturnType<typeof streamText<ToolSet>>;
      sources: KbAnswerSource[];
    };

interface AnswerOptions {
  orgId: string;
  question: string;
  articleId?: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

@Injectable()
export class KbRagService {
  private readonly breaker: AiStreamBreaker;

  constructor(
    private readonly retrieval: KbRagRetrievalService,
    private readonly aiGateway: AiGatewayService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
    @Optional() @Inject(REDIS) private readonly redis: Redis | null = null,
  ) {
    this.breaker = new AiStreamBreaker({
      key: "kb",
      unavailableMessage: KB_BREAKER_MESSAGE,
      redis: this.redis,
    });
  }

  isEmbeddingConfigured(): boolean {
    return this.retrieval.isEmbeddingConfigured();
  }

  private async chargeOrgAskBudget(orgId: string): Promise<void> {
    if (!this.redis) return;
    const windowSecs = rateLimitWindowSecs(PUBLIC_KB_ASK_ORG_TIER);
    const [hits, ttlSecs] = await this.redis.eval<[string], [number, number]>(
      PUBLIC_KB_ASK_ORG_WINDOW_SCRIPT,
      [publicKbAskOrgKey(orgId)],
      [String(windowSecs)],
    );
    if (hits <= effectiveRateLimit(PUBLIC_KB_ASK_ORG_TIER)) return;
    throw new HttpException(
      {
        message: "This knowledge base is answering too many questions right now",
        retryAfterSecs: ttlSecs > 0 ? ttlSecs : windowSecs,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async runAnswer(opts: AnswerOptions): Promise<KbAnswer> {
    const ctx = await this.retrieval.retrieveContext(opts.orgId, opts.question, opts.articleId);
    if (!ctx) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      return { answer: KB_NO_CONTEXT_ANSWER, sources: [], hasContext: false };
    }

    const userMessage = `${ctx.userContext}\n\nQuestion: ${opts.question}`;

    const gatewayResult = await this.aiGateway.invokeText({
      actor: { orgId: opts.orgId, userId: null },
      feature: "kb.public-ask",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      prompt: { system: ctx.system, user: userMessage },
    });

    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      if (gatewayResult.kind === "provider_unavailable") this.breaker.recordFailure();
      throw new AiProviderUnavailableException();
    }

    this.breaker.recordSuccess();

    return {
      answer: gatewayResult.data.trim(),
      sources: ctx.sources,
      hasContext: true,
    };
  }

  async answerQuestion(opts: AnswerOptions): Promise<KbAnswer> {
    await this.breaker.assertClosed();
    await this.chargeOrgAskBudget(opts.orgId);
    const hasArticles = await this.retrieval.hasPublishedPublicArticles(opts.orgId, opts.articleId);
    if (!hasArticles) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      return {
        answer: KB_NO_CONTEXT_ANSWER,
        sources: [],
        hasContext: false,
      };
    }
    return this.runAnswer(opts);
  }

  async streamAnswer(opts: AnswerOptions, signal?: AbortSignal): Promise<KbStreamAnswer> {
    const call = AiCallMetrics.begin({
      feature: KB_RAG_STREAM_FEATURE,
      tier: "chat",
      orgId: opts.orgId,
    });
    await this.breaker.assertClosed();
    await this.chargeOrgAskBudget(opts.orgId);
    const hasArticles = await this.retrieval.hasPublishedPublicArticles(opts.orgId, opts.articleId);
    if (!hasArticles) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      call.finish("ok", { promptTokens: 0, completionTokens: 0, creditsMilli: 0 });
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const ctx = await this.retrieval.retrieveContext(
      opts.orgId,
      opts.question,
      opts.articleId,
      signal,
    );
    if (!ctx) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      call.finish("ok", { promptTokens: 0, completionTokens: 0, creditsMilli: 0 });
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const { sources, system, userContext } = ctx;
    const userMessage = `${userContext}\n\nQuestion: ${opts.question}`;

    const acquired = await call.queue(() => this.concurrencyLimiter.acquire(opts.orgId));
    if (!acquired) {
      call.finish("concurrency_exceeded");
      throw new AiConcurrencyLimitException();
    }

    let concurrencyReleased = false;
    const releaseConcurrency = () => {
      if (concurrencyReleased) return;
      concurrencyReleased = true;
      this.concurrencyLimiter.release(opts.orgId);
    };

    let reservation: ReservationHandle;
    try {
      const reserveMilli = getReserveEstimateMilli(KB_RAG_STREAM_FEATURE);
      const idempotencyKey = aiReservationIdempotencyKey(KB_RAG_STREAM_FEATURE, {
        orgId: opts.orgId,
        userId: null,
      });
      const reserved = await this.ledger.reserve({
        orgId: opts.orgId,
        userId: null,
        feature: KB_RAG_STREAM_FEATURE,
        credits: reserveMilli,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      reservation = makeReservationHandle(
        reserved.reservationId,
        opts.orgId,
        this.ledger,
        KB_RAG_STREAM_FEATURE,
      );
    } catch (error) {
      releaseConcurrency();
      call.finish("quota_exceeded");
      throw error;
    }

    try {
      const modelId = resolveChatModelId();
      call.providerOpened();
      const stream = streamText({
        model: resolveChatModel(),
        messages: [{ role: "user", content: userMessage }],
        system,
        maxOutputTokens: 1024,
        maxRetries: resolveLlmRetryPolicy().maxRetriesPerModel,
        ...(signal !== undefined ? { abortSignal: signal } : {}),
        onChunk: () => call.firstToken(),
        onError: ({ error }) => {
          if (signal?.aborted === true || isAbortError(error)) return;
          this.breaker.recordFailure();
          logger.warn("KB RAG stream failed", {
            error: error instanceof Error ? error.message : String(error),
            orgId: opts.orgId,
          });
        },
        onFinish: async ({ usage }) => {
          if (!reservation.markSettled()) return;
          releaseConcurrency();
          this.breaker.recordSuccess();
          const promptTokens = usage?.inputTokens ?? 0;
          const completionTokens = usage?.outputTokens ?? 0;
          const timings = call.finish("ok", {
            model: modelId,
            promptTokens,
            completionTokens,
          });
          try {
            await settleStream(this.ledger, this.usageSvc, {
              reservationId: reservation.reservationId,
              model: modelId,
              promptTokens,
              completionTokens,
              orgId: opts.orgId,
              userId: null,
              feature: KB_RAG_STREAM_FEATURE,
              ...(timings.ttftMs !== undefined ? { ttftMs: timings.ttftMs } : {}),
              appOverheadMs: timings.overheadMs,
              timings,
            });
          } catch (err) {
            logger.error("Failed to settle KB RAG stream", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              orgId: opts.orgId,
              reservationId: reservation.reservationId,
            });
          }
        },
      });

      void Promise.resolve(stream.finishReason).catch(() => {
        releaseConcurrency();
        reservation.release("stream_aborted_no_settle");
        call.finish(signal?.aborted === true ? "cancelled" : "provider_unavailable");
      });

      return { stream, sources, hasContext: true };
    } catch (error) {
      this.breaker.recordFailure();
      releaseConcurrency();
      reservation.release("stream_setup_error");
      call.finish("error");
      throw error;
    }
  }
}
