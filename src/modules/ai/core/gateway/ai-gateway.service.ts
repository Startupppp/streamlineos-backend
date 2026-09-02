import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { LlmService } from "../providers/llm.service";
import { EmbeddingsService } from "../providers/embeddings.service";
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
import { AiCallMetrics } from "../telemetry/ai-call-metrics";
import { AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import { AiGatewayRunnerHelper } from "./ai-gateway-runner.helper";
import { AiGatewayEmbedHelper } from "./ai-gateway-embed.helper";
import { AiResponseCacheService } from "./ai-response-cache.service";
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
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
  EmbedBatchOpts,
  EmbedBatchResult,
} from "./ai-gateway.types";

export type {
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
  EmbedQueryOpts,
  EmbedQueryResult,
  EmbedBatchOpts,
  EmbedBatchResult,
};

const CONCURRENCY_EXCEEDED_MESSAGE = "Too many concurrent AI requests for this organization";
const EMBEDDING_TIER = "embedding";

function resolveCacheOpts(cache: AiResponseCacheOpts | undefined): AiResponseCacheOpts | null {
  return cache ?? null;
}

@Injectable()
export class AiGatewayService {
  private readonly inflightMap = new Map<
    string,
    Promise<AiInvokeResult<unknown>>
  >();
  private readonly runner: AiGatewayRunnerHelper;
  private readonly embedder: AiGatewayEmbedHelper;

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
    this.embedder = new AiGatewayEmbedHelper(embeddings, ledger, usageSvc);
  }

  /**
   * Every entry point opens exactly one of these, and the correlation id comes
   * off it. It is what joins the call, its `ai_usage_logs` row and its audit
   * entry back to the request that caused them; before it, each of these methods
   * minted a fresh `randomUUID()` and every AI call was an orphan trace.
   */
  private beginCall(opts: {
    feature: string;
    tier?: string;
    orgId: string;
  }): AiCallMetrics {
    return AiCallMetrics.begin({
      feature: opts.feature,
      ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
      orgId: opts.orgId,
    });
  }

  isEmbeddingConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  async embedQueryWithCredit(opts: EmbedQueryOpts): Promise<EmbedQueryResult> {
    const call = this.beginCall({ feature: opts.feature, tier: EMBEDDING_TIER, orgId: opts.orgId });
    const correlationId = call.correlationId;
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    }
    try {
      return await this.embedder.run(opts, correlationId, call);
    } finally {
      this.concurrencyLimiter.release(opts.orgId);
    }
  }

  async embedBatchWithCredit(opts: EmbedBatchOpts): Promise<EmbedBatchResult> {
    const call = this.beginCall({ feature: opts.feature, tier: EMBEDDING_TIER, orgId: opts.orgId });
    const correlationId = call.correlationId;
    if (opts.texts.length === 0) {
      call.finish("ok", { promptTokens: 0, completionTokens: 0, creditsMilli: 0 });
      return { ok: true, vectors: [] };
    }

    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    }
    try {
      return await this.embedder.runBatch(opts, correlationId, call);
    } finally {
      this.concurrencyLimiter.release(opts.orgId);
    }
  }

  async invokeStructured<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const correlationId = call.correlationId;
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;
    const cacheOpts = resolveCacheOpts(opts.cache);

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) {
        call.served();
        call.finish("dedupe_hit");
        return inflight as Promise<AiInvokeResult<T>>;
      }
    }

    let invoked = false;
    const runLimited = async (): Promise<AiInvokeResult<T>> => {
      invoked = true;
      const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
      if (!allowed) {
        call.finish("concurrency_exceeded");
        return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
      }
      try {
        return await this.runner.runStructured(opts, correlationId, call);
      } finally {
        this.concurrencyLimiter.release(opts.actor.orgId);
      }
    };

    const throughCache = async (
      cache: AiResponseCacheOpts,
      fetcher: () => Promise<AiInvokeResult<T>>,
    ): Promise<AiInvokeResult<T>> => {
      const outcome = await this.responseCache.cachedInvoke<T>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cache,
      }, fetcher);
      if (!invoked) {
        call.served();
        call.finish("cache_hit");
      }
      return outcome;
    };

    if (dedupeKey && cacheOpts) {
      return throughCache(cacheOpts, async () => {
        const promise = runLimited();
        this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
        promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
        return promise;
      });
    }

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

    if (cacheOpts) return throughCache(cacheOpts, runLimited);

    return runLimited();
  }

  async invokeStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId: call.correlationId };
    }
    try {
      return await this.runner.runStructuredWithUsage(opts, call.correlationId, call);
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeStructuredWithImage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId: call.correlationId };
    }
    try {
      return await this.runner.runStructuredWithImage(opts, call.correlationId, call);
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeStructuredWithImageWithUsage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId: call.correlationId };
    }
    try {
      const result = await this.runner.runStructuredWithImage(opts, call.correlationId, call);
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
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const correlationId = call.correlationId;
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;
    const cacheOpts = resolveCacheOpts(opts.cache);

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) {
        call.served();
        call.finish("dedupe_hit");
        return inflight as Promise<AiInvokeResult<string>>;
      }
    }

    let invoked = false;
    const runLimited = async (): Promise<AiInvokeResult<string>> => {
      invoked = true;
      const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
      if (!allowed) {
        call.finish("concurrency_exceeded");
        return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
      }
      try {
        return await this.runner.runText(opts, correlationId, call);
      } finally {
        this.concurrencyLimiter.release(opts.actor.orgId);
      }
    };

    const throughCache = async (
      cache: AiResponseCacheOpts,
      fetcher: () => Promise<AiInvokeResult<string>>,
    ): Promise<AiInvokeResult<string>> => {
      const outcome = await this.responseCache.cachedInvoke<string>(opts.actor.orgId, {
        feature: opts.feature, tier: opts.tier,
        promptSystem: opts.prompt.system, promptUser: opts.prompt.user, ...cache,
      }, fetcher);
      if (!invoked) {
        call.served();
        call.finish("cache_hit");
      }
      return outcome;
    };

    if (dedupeKey && cacheOpts) {
      return throughCache(cacheOpts, async () => {
        const promise = runLimited();
        this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
        promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
        return promise;
      });
    }

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

    if (cacheOpts) return throughCache(cacheOpts, runLimited);

    return runLimited();
  }

  async invokeTextWithUsage(
    opts: InvokeTextOpts,
  ): Promise<AiInvokeWithUsageResult<string>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.actor.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId: call.correlationId };
    }
    try {
      return await this.runner.runTextWithUsage(opts, call.correlationId, call);
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
