import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { LlmService } from "../providers/llm.service";
import { EmbeddingsService, EMBEDDING_MODEL } from "../providers/embeddings.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../../common/audit/audit.service";
import {
  AI_CREDIT_LEDGER,
  type AiCreditLedger,
} from "./credit-ledger.interface";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import { AiGatewayRunnerHelper } from "./ai-gateway-runner.helper";
import { AiResponseCacheService } from "./ai-response-cache.service";
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  AiUsageMeta,
  AiInvokeBaseOpts,
  AiResponseCacheOpts,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
  EmbedQueryOpts,
  EmbedQueryResult,
} from "./ai-gateway.types";

export type {
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
  EmbedQueryOpts,
  EmbedQueryResult,
};

const CONCURRENCY_EXCEEDED_MESSAGE = "Too many concurrent AI requests for this organization";

function resolveCacheOpts(cache: AiResponseCacheOpts | undefined): AiResponseCacheOpts | null {
  return cache ?? null;
}

function estimateEmbedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

@Injectable()
export class AiGatewayService {
  private readonly inflightMap = new Map<
    string,
    Promise<AiInvokeResult<unknown>>
  >();
  private readonly runner: AiGatewayRunnerHelper;

  constructor(
    private readonly llm: LlmService,
    private readonly embeddings: EmbeddingsService,
    private readonly usageSvc: AiUsageService,
    private readonly audit: AuditService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
    private readonly responseCache: AiResponseCacheService,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
  ) {
    const credit = new AiGatewayCreditHelper(ledger, usageSvc, audit);
    this.runner = new AiGatewayRunnerHelper(llm, credit);
  }

  isEmbeddingConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  async embedQueryWithCredit(opts: EmbedQueryOpts): Promise<EmbedQueryResult> {
    const { text, orgId, feature, charge } = opts;
    const correlationId = randomUUID();
    let reservationId = 0;

    if (charge) {
      const reserveMilli = getReserveEstimateMilli(feature);
      try {
        const reserved = await this.ledger.reserve({ orgId, userId: null, feature, credits: reserveMilli });
        reservationId = reserved.reservationId;
      } catch (error) {
        if (error instanceof InsufficientAiCreditsException)
          return { ok: false, kind: "quota_exceeded", message: error.message, correlationId };
        throw error;
      }
    }

    try {
      const vector = await this.embeddings.embedQuery(text, orgId, feature);
      const estimatedTokens = estimateEmbedTokens(text);
      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(EMBEDDING_MODEL, estimatedTokens, 0)
        : { costUsd: 0, milliCredits: 0 };

      if (charge && reservationId !== 0)
        await this.ledger.settle(reservationId, { orgId, actualMilli: milliCredits, model: EMBEDDING_MODEL, promptTokens: estimatedTokens, completionTokens: 0, totalTokens: estimatedTokens, costUsd });

      return { ok: true, vector, vectorLiteral: this.embeddings.toVectorLiteral(vector) };
    } catch (error) {
      if (reservationId !== 0)
        await this.ledger.release(reservationId, "embedding_error", orgId).catch(() => undefined);
      return { ok: false, kind: "provider_unavailable", message: "Embedding provider is temporarily unavailable", correlationId };
    }
  }

  async invokeStructured<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;
    const cacheOpts = resolveCacheOpts(opts.cache);

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<T>>;
    }

    const runLimited = async (): Promise<AiInvokeResult<T>> => {
      const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
      if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
      try {
        return await this.runner.runStructured(opts, correlationId);
      } finally {
        this.concurrencyLimiter.release(opts.actor.orgId);
      }
    };

    if (dedupeKey && cacheOpts) {
      return this.responseCache.cachedInvoke<T>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cacheOpts,
      }, async () => {
        const promise = runLimited();
        this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
        promise.finally(() => this.inflightMap.delete(dedupeKey!)).catch(() => undefined);
        return promise;
      });
    }

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

    if (cacheOpts) {
      return this.responseCache.cachedInvoke<T>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cacheOpts,
      }, runLimited);
    }

    return runLimited();
  }

  async invokeStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const correlationId = randomUUID();
    const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
    if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    try {
      return await this.runner.runStructuredWithUsage(opts, correlationId);
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeStructuredWithImage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const correlationId = randomUUID();
    const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
    if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    try {
      return await this.runner.runStructuredWithImage(opts, correlationId);
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeStructuredWithImageWithUsage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const correlationId = randomUUID();
    const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
    if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    try {
      const result = await this.runner.runStructuredWithImage(opts, correlationId);
      if (!result.ok) return result;

      const { costUsd, milliCredits } = computeTokenCharge(
        result.model,
        result.usage.promptTokens ?? 0,
        result.usage.completionTokens ?? 0,
      );

      const aiUsage: AiUsageMeta = {
        model: result.model,
        promptTokens: result.usage.promptTokens ?? 0,
        completionTokens: result.usage.completionTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        credits: milliToCredits(milliCredits),
        costUsd,
      };

      return { ok: true, data: result.data, aiUsage };
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeText(opts: InvokeTextOpts): Promise<AiInvokeResult<string>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;
    const cacheOpts = resolveCacheOpts(opts.cache);

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<string>>;
    }

    const runLimited = async (): Promise<AiInvokeResult<string>> => {
      const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
      if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
      try {
        return await this.runner.runText(opts, correlationId);
      } finally {
        this.concurrencyLimiter.release(opts.actor.orgId);
      }
    };

    if (dedupeKey && cacheOpts) {
      return this.responseCache.cachedInvoke<string>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cacheOpts,
      }, async () => {
        const promise = runLimited();
        this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
        promise.finally(() => this.inflightMap.delete(dedupeKey!)).catch(() => undefined);
        return promise;
      });
    }

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

    if (cacheOpts) {
      return this.responseCache.cachedInvoke<string>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cacheOpts,
      }, runLimited);
    }

    return runLimited();
  }

  async invokeTextWithUsage(
    opts: InvokeTextOpts,
  ): Promise<AiInvokeWithUsageResult<string>> {
    const correlationId = randomUUID();
    const allowed = await this.concurrencyLimiter.acquire(opts.actor.orgId);
    if (!allowed) return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    try {
      return await this.runner.runTextWithUsage(opts, correlationId);
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }
}

function buildDedupeKey(opts: AiInvokeBaseOpts): string {
  const content = opts.prompt.system + opts.prompt.user;
  const hash = createHash("sha256").update(content).digest("hex");
  return `${opts.actor.orgId}:${opts.actor.userId ?? "anon"}:${opts.feature}:${hash}`;
}
