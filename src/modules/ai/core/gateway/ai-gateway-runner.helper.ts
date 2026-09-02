import { LlmService } from "../providers/llm.service";
import { AiCallMetrics } from "../telemetry/ai-call-metrics";
import { AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import {
  boundedMaxTokens,
  preflightCall,
  settleFailedCall,
  settleSuccessfulCall,
  withUsageMeta,
} from "./ai-gateway-runner-call";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
} from "./ai-gateway.types";

/**
 * Drives one provider call per public method. Everything the three runners share —
 * redaction, the context ceiling, cancellation, the credit reservation and the
 * measured-token settlement — lives in `ai-gateway-runner-call`; what stays here is
 * only the provider method each shape invokes and how its payload becomes `data`.
 */
export class AiGatewayRunnerHelper {
  constructor(
    private readonly llm: LlmService,
    private readonly credit: AiGatewayCreditHelper,
  ) {}

  /**
   * Defaulted rather than required so the call sites that pass only a correlation
   * id still compile — but never absent, so a path can lose its metrics only by
   * deleting the default, not by forgetting an argument.
   */
  private metricsFor(
    opts: { feature: string; tier?: string; actor: { orgId: string } },
    metrics: AiCallMetrics | undefined,
  ): AiCallMetrics {
    return (
      metrics ??
      AiCallMetrics.begin({
        feature: opts.feature,
        ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
        orgId: opts.actor.orgId,
      })
    );
  }

  async runStructured<T>(
    opts: InvokeStructuredOpts<T>,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeResult<T>> {
    const call = this.metricsFor(opts, metrics);
    const gate = await preflightCall(this.credit, opts, correlationId, call);
    if (gate.kind === "reject") return gate.failure;

    const startedAt = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeStructuredWithUsage({
          model: opts.tier ?? "fast",
          schema: opts.schema,
          schemaName: opts.feature.replace(/[^a-z0-9]/gi, "_"),
          system: gate.prompt.system,
          user: gate.prompt.user,
          maxTokens: boundedMaxTokens(opts.maxTokens),
          onRetry: () => call.retried(),
          ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        }),
      );

      return await settleSuccessfulCall(this.credit, {
        call,
        opts,
        correlationId,
        reserveMilli: gate.reserveMilli,
        reservationId: gate.reservationId,
        startedAt,
        model: result.model,
        usage: result.usage,
        data: result.data,
      });
    } catch (error) {
      return settleFailedCall(this.credit, {
        call,
        opts,
        correlationId,
        reservationId: gate.reservationId,
        startedAt,
        signal: gate.signal,
        error,
      });
    }
  }

  async runStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeWithUsageResult<T>> {
    return withUsageMeta(await this.runStructured(opts, correlationId, metrics));
  }

  async runStructuredWithImage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeResult<T>> {
    const call = this.metricsFor(opts, metrics);
    const gate = await preflightCall(this.credit, opts, correlationId, call);
    if (gate.kind === "reject") return gate.failure;

    const startedAt = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeStructuredWithImageWithUsage({
          model: opts.tier ?? "fast",
          schema: opts.schema,
          schemaName: opts.feature.replace(/[^a-z0-9]/gi, "_"),
          system: gate.prompt.system,
          user: gate.prompt.user,
          images: opts.images,
          maxTokens: boundedMaxTokens(opts.maxTokens),
          onRetry: () => call.retried(),
          ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        }),
      );

      return await settleSuccessfulCall(this.credit, {
        call,
        opts,
        correlationId,
        reserveMilli: gate.reserveMilli,
        reservationId: gate.reservationId,
        startedAt,
        model: result.model,
        usage: result.usage,
        data: result.data,
      });
    } catch (error) {
      return settleFailedCall(this.credit, {
        call,
        opts,
        correlationId,
        reservationId: gate.reservationId,
        startedAt,
        signal: gate.signal,
        error,
      });
    }
  }

  async runText(
    opts: InvokeTextOpts,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeResult<string>> {
    const call = this.metricsFor(opts, metrics);
    const gate = await preflightCall(this.credit, opts, correlationId, call);
    if (gate.kind === "reject") return gate.failure;

    const startedAt = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeTextWithUsage({
          model: opts.tier ?? "fast",
          system: gate.prompt.system,
          user: gate.prompt.user,
          maxTokens: boundedMaxTokens(opts.maxTokens),
          onRetry: () => call.retried(),
          ...(gate.signal !== undefined ? { signal: gate.signal } : {}),
        }),
      );

      return await settleSuccessfulCall(this.credit, {
        call,
        opts,
        correlationId,
        reserveMilli: gate.reserveMilli,
        reservationId: gate.reservationId,
        startedAt,
        model: result.model,
        usage: result.usage,
        data: result.text,
      });
    } catch (error) {
      return settleFailedCall(this.credit, {
        call,
        opts,
        correlationId,
        reservationId: gate.reservationId,
        startedAt,
        signal: gate.signal,
        error,
      });
    }
  }

  async runTextWithUsage(
    opts: InvokeTextOpts,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeWithUsageResult<string>> {
    return withUsageMeta(await this.runText(opts, correlationId, metrics));
  }
}
