import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { streamText, type ToolSet } from "ai";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../gateway/credit-ledger.interface";
import { AiUsageService } from "./ai-usage.service";
import { settleStream } from "../gateway/ai-gateway-credit.helper";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { resolveChatModel, resolveChatModelId } from "./chat-assistant-model";
import { logger } from "../../../../common/logger/logger.service";
import { KbRagRetrievalService, type KbAnswerSource } from "./kb-rag-retrieval.service";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";

const KB_RAG_STREAM_FEATURE = "kb.public-ask";
const KB_NO_CONTEXT_ANSWER = "I couldn't find anything related to that in the knowledge base yet.";

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
  constructor(
    private readonly retrieval: KbRagRetrievalService,
    private readonly aiGateway: AiGatewayService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
  ) {}

  isEmbeddingConfigured(): boolean {
    return this.retrieval.isEmbeddingConfigured();
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
      throw new ServiceUnavailableException("AI provider is temporarily unavailable");
    }

    return {
      answer: gatewayResult.data.trim(),
      sources: ctx.sources,
      hasContext: true,
    };
  }

  async answerQuestion(opts: AnswerOptions): Promise<KbAnswer> {
    const hasArticles = await this.retrieval.hasPublishedPublicArticles(opts.orgId);
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
    const hasArticles = await this.retrieval.hasPublishedPublicArticles(opts.orgId);
    if (!hasArticles) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const ctx = await this.retrieval.retrieveContext(opts.orgId, opts.question, opts.articleId);
    if (!ctx) {
      this.retrieval.recordNoContext(opts.orgId, opts.question);
      return { hasContext: false, answer: KB_NO_CONTEXT_ANSWER, sources: [] };
    }

    const { sources, system, userContext } = ctx;
    const userMessage = `${userContext}\n\nQuestion: ${opts.question}`;

    const appStart = Date.now();

    const acquired = await this.concurrencyLimiter.acquire(opts.orgId);
    if (!acquired)
      throw new ServiceUnavailableException("Too many concurrent AI requests for this organization");

    let concurrencyReleased = false;
    const releaseConcurrency = () => {
      if (concurrencyReleased) return;
      concurrencyReleased = true;
      this.concurrencyLimiter.release(opts.orgId);
    };

    const reserveMilli = getReserveEstimateMilli(KB_RAG_STREAM_FEATURE);
    const { reservationId } = await this.ledger.reserve({
      orgId: opts.orgId,
      userId: null,
      feature: KB_RAG_STREAM_FEATURE,
      credits: reserveMilli,
    });

    let resolved = false;
    const releaseReservation = (reason: string) => {
      if (resolved) return;
      resolved = true;
      void this.ledger.release(reservationId, reason, opts.orgId).catch(() => undefined);
    };

    const modelId = resolveChatModelId();
    const streamStart = Date.now();
    const appOverheadMs = streamStart - appStart;
    let ttftMs = 0;
    let firstChunk = true;

    try {
      const stream = streamText({
        model: resolveChatModel(),
        messages: [{ role: "user", content: userMessage }],
        system,
        maxOutputTokens: 1024,
        maxRetries: 0,
        ...(signal !== undefined ? { abortSignal: signal } : {}),
        onChunk: () => {
          if (!firstChunk) return;
          firstChunk = false;
          ttftMs = Date.now() - streamStart;
        },
        onError: ({ error }) => {
          if (signal?.aborted === true || isAbortError(error)) return;
          logger.warn("KB RAG stream failed", {
            error: error instanceof Error ? error.message : String(error),
            orgId: opts.orgId,
          });
        },
        onFinish: async ({ usage }) => {
          if (resolved) return;
          resolved = true;
          releaseConcurrency();
          const promptTokens = usage?.inputTokens ?? 0;
          const completionTokens = usage?.outputTokens ?? 0;
          try {
            await settleStream(this.ledger, this.usageSvc, {
              reservationId,
              model: modelId,
              promptTokens,
              completionTokens,
              orgId: opts.orgId,
              userId: null,
              feature: KB_RAG_STREAM_FEATURE,
              ttftMs,
              appOverheadMs,
            });
          } catch (err) {
            logger.error("Failed to settle KB RAG stream", {
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              orgId: opts.orgId,
              reservationId,
            });
          }
        },
      });

      void Promise.resolve(stream.finishReason).catch(() => {
        releaseConcurrency();
        releaseReservation("stream_aborted_no_settle");
      });

      return { stream, sources, hasContext: true };
    } catch (error) {
      releaseConcurrency();
      releaseReservation("stream_setup_error");
      throw error;
    }
  }
}
