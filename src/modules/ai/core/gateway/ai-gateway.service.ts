import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { LlmService } from "../providers/llm.service";
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
import { AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import { AiGatewayRunnerHelper } from "./ai-gateway-runner.helper";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  AiUsageMeta,
  AiInvokeBaseOpts,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
} from "./ai-gateway.types";

export type {
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
};

@Injectable()
export class AiGatewayService {
  private readonly inflightMap = new Map<
    string,
    Promise<AiInvokeResult<unknown>>
  >();
  private readonly runner: AiGatewayRunnerHelper;

  constructor(
    private readonly llm: LlmService,
    private readonly usageSvc: AiUsageService,
    private readonly audit: AuditService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
  ) {
    const credit = new AiGatewayCreditHelper(ledger, usageSvc, audit);
    this.runner = new AiGatewayRunnerHelper(llm, credit);
  }

  async invokeStructured<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<T>>;
    }

    const promise = this.runner.runStructured(opts, correlationId);

    if (dedupeKey) {
      this.inflightMap.set(
        dedupeKey,
        promise as Promise<AiInvokeResult<unknown>>,
      );
      promise
        .finally(() => this.inflightMap.delete(dedupeKey))
        .catch(() => undefined);
    }

    return promise;
  }

  async invokeStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const correlationId = randomUUID();
    return this.runner.runStructuredWithUsage(opts, correlationId);
  }

  async invokeStructuredWithImage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeResult<T>> {
    const correlationId = randomUUID();
    return this.runner.runStructuredWithImage(opts, correlationId);
  }

  async invokeStructuredWithImageWithUsage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const correlationId = randomUUID();
    const result = await this.runner.runStructuredWithImage(
      opts,
      correlationId,
    );
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

    return { ok: true, data: result.data, aiUsage, correlationId };
  }

  async invokeText(opts: InvokeTextOpts): Promise<AiInvokeResult<string>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<string>>;
    }

    const promise = this.runner.runText(opts, correlationId);

    if (dedupeKey) {
      this.inflightMap.set(
        dedupeKey,
        promise as Promise<AiInvokeResult<unknown>>,
      );
      promise
        .finally(() => this.inflightMap.delete(dedupeKey))
        .catch(() => undefined);
    }

    return promise;
  }

  async invokeTextWithUsage(
    opts: InvokeTextOpts,
  ): Promise<AiInvokeWithUsageResult<string>> {
    const correlationId = randomUUID();
    return this.runner.runTextWithUsage(opts, correlationId);
  }
}

function buildDedupeKey(opts: AiInvokeBaseOpts): string {
  const content = opts.prompt.system + opts.prompt.user;
  const hash = createHash("sha256").update(content).digest("hex");
  return `${opts.actor.orgId}:${opts.actor.userId ?? "anon"}:${opts.feature}:${hash}`;
}
