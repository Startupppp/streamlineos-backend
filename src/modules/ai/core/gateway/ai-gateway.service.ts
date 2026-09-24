import { Inject, Injectable, Optional } from "@nestjs/common";
import { Redis } from "@upstash/redis";
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
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
import {
  getAiRequestAbortSignal,
  getAmbientAiAbortSignal,
} from "../streaming/ai-request-abort";
import { REDIS } from "../../../../common/cache/cache.service";
import {
  AiGatewayStreamHelper,
  type AiStreamTextOpts,
  type AiTextStream,
} from "./ai-gateway-stream.helper";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  AiUsageMeta,
  AiInvokeBaseOpts,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
  EmbedQueryOpts,
  EmbedQueryResult,
  EmbedBatchOpts,
  EmbedBatchResult,
} from "./ai-gateway.types";

export type {
  AiStreamTextOpts,
  AiTextStream,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
  EmbedQueryOpts,
  EmbedQueryResult,
  EmbedBatchOpts,
  EmbedBatchResult,
};

const CONCURRENCY_EXCEEDED_MESSAGE = "Too many concurrent AI requests for this organization";
const CANCELLED_MESSAGE = "AI request was cancelled before it completed";
const EMBEDDING_TIER = "embedding";

@Injectable()
export class AiGatewayService {
  private readonly inflightMap = new Map<
    string,
    Promise<AiInvokeResult<unknown>>
  >();
  private readonly runner: AiGatewayRunnerHelper;
  private readonly embedder: AiGatewayEmbedHelper;
  private readonly streamer: AiGatewayStreamHelper;

  constructor(
    private readonly llm: LlmService,
    private readonly embeddings: EmbeddingsService,
    private readonly usageSvc: AiUsageService,
    private readonly audit: AuditService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
    @Optional() @Inject(REDIS) redis: Redis | null = null,
  ) {
    const credit = new AiGatewayCreditHelper(ledger, usageSvc, audit);
    this.runner = new AiGatewayRunnerHelper(llm, credit);
    this.embedder = new AiGatewayEmbedHelper(embeddings, ledger, usageSvc);
    this.streamer = new AiGatewayStreamHelper(ledger, usageSvc, concurrencyLimiter, redis, audit);
  }

  async streamTextWithUsage(opts: AiStreamTextOpts): Promise<AiTextStream> {
    const signal = opts.signal ?? getAmbientAiAbortSignal();
    return this.streamer.run({ ...opts, ...(signal !== undefined ? { signal } : {}) });
  }

  async streamAgenticTurn(opts: AiStreamTextOpts): Promise<AiTextStream> {
    return this.streamTextWithUsage(opts);
  }

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
    const signal = opts.signal ?? getAmbientAiAbortSignal();
    if (signal?.aborted === true) {
      call.finish("cancelled");
      return { ok: false, kind: "cancelled", message: CANCELLED_MESSAGE, correlationId };
    }
    const allowed = await call.queue(() => this.concurrencyLimiter.acquire(opts.orgId));
    if (!allowed) {
      call.finish("concurrency_exceeded");
      return { ok: false, kind: "concurrency_exceeded", message: CONCURRENCY_EXCEEDED_MESSAGE, correlationId };
    }
    try {
      return await this.embedder.run(
        { ...opts, ...(signal !== undefined ? { signal } : {}) },
        correlationId,
        call,
      );
    } finally {
      this.concurrencyLimiter.release(opts.orgId);
    }
  }

  async embedBatchWithCredit(opts: EmbedBatchOpts): Promise<EmbedBatchResult> {
    const call = this.beginCall({ feature: opts.feature, tier: EMBEDDING_TIER, orgId: opts.orgId });
    const correlationId = call.correlationId;
    const signal = opts.signal ?? getAiRequestAbortSignal();
    if (signal?.aborted === true) {
      call.finish("cancelled");
      return { ok: false, kind: "cancelled", message: CANCELLED_MESSAGE, correlationId };
    }
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
      return await this.embedder.runBatch(
        { ...opts, ...(signal !== undefined ? { signal } : {}) },
        correlationId,
        call,
      );
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

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) {
        call.served();
        call.finish("dedupe_hit");
        const result = await inflight;
        if (!result.ok) return result;
        return { ...result, data: opts.schema.parse(result.data) };
      }
    }

    const runLimited = async (): Promise<AiInvokeResult<T>> => {
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

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

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

      return { ok: true, data: result.data, aiUsage, correlationId: call.correlationId };
    } finally {
      this.concurrencyLimiter.release(opts.actor.orgId);
    }
  }

  async invokeText(opts: InvokeTextOpts): Promise<AiInvokeResult<string>> {
    const call = this.beginCall({ feature: opts.feature, ...(opts.tier !== undefined ? { tier: opts.tier } : {}), orgId: opts.actor.orgId });
    const correlationId = call.correlationId;
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) {
        call.served();
        call.finish("dedupe_hit");
        const result = await inflight;
        if (!result.ok) return result;
        return { ...result, data: String(result.data) };
      }
    }

    const runLimited = async (): Promise<AiInvokeResult<string>> => {
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

    if (dedupeKey) {
      const promise = runLimited();
      this.inflightMap.set(dedupeKey, promise);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
      return promise;
    }

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
