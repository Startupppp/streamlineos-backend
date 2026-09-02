import { LlmService } from "../providers/llm.service";
import { redactSensitiveData } from "../redaction.util";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";
import { getReserveEstimateMilli as getCatalogEstimateMilli } from "../billing/ai-cost-catalog";
import { AiCallMetrics, type AiCallOutcome } from "../telemetry/ai-call-metrics";
import { AI_CANCELLED_MESSAGE, AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import { getAiRequestAbortSignal } from "../streaming/ai-request-abort";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  AiUsageMeta,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
} from "./ai-gateway.types";

const MAX_CONTEXT_CHARS_DEFAULT = 200_000;
const MAX_OUTPUT_TOKENS_DEFAULT = 4_096;

function contextExceedsLimit(prompt: { system: string; user: string }, max: number): boolean {
  return prompt.system.length + prompt.user.length > max;
}

function boundedMaxTokens(requested: number | undefined): number {
  if (requested === undefined) return MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(requested, MAX_OUTPUT_TOKENS_DEFAULT);
}

/**
 * A client that hung up did not make the provider fail, and counting it as a
 * provider failure is how a breaker trips on a busy afternoon of people closing
 * tabs. Recorded as its own outcome instead.
 */
function outcomeForError(signal: AbortSignal | undefined): AiCallOutcome | undefined {
  return signal?.aborted === true ? "cancelled" : undefined;
}

/**
 * Explicit wins over ambient, so a caller holding its own handle (the streaming
 * routes) keeps its deadline; everything else inherits the request's.
 */
function resolveSignal(explicit: AbortSignal | undefined): AbortSignal | undefined {
  return explicit ?? getAiRequestAbortSignal();
}

function cancelledFailure(correlationId: string): AiInvokeResult<never> {
  return { ok: false, kind: "cancelled", message: AI_CANCELLED_MESSAGE, correlationId };
}

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
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      call.finish("context_too_large");
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
    }

    const signal = resolveSignal(opts.signal);
    if (signal?.aborted === true) {
      call.finish("cancelled");
      return cancelledFailure(correlationId);
    }

    const reserveMilli = charge ? getCatalogEstimateMilli(feature) : 0;
    let reservationId = 0;

    if (charge) {
      const reserveResult = await this.credit.reserveCredits(
        reserveMilli,
        actor,
        feature,
        correlationId,
      );
      if (!reserveResult.reserved) {
        call.finish(reserveResult.kind);
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      }
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeStructuredWithUsage({
          model: tier ?? "fast",
          schema: opts.schema,
          schemaName: feature.replace(/[^a-z0-9]/gi, "_"),
          system: prompt.system,
          user: prompt.user,
          maxTokens: boundedMaxTokens(maxTokens),
          onRetry: () => call.retried(),
          ...(signal !== undefined ? { signal } : {}),
        }),
      );

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      const timings = call.finish("ok", {
        model: result.model,
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        creditsMilli: milliCredits,
        costUsd,
      });

      await this.credit.settleAndTrack({
        reservationId,
        charge: charge ? { milli: reserveMilli } : undefined,
        model: result.model,
        usage,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        outcome: "ok",
        actualMilli: milliCredits,
        costUsd,
        timings,
      });

      return {
        ok: true,
        data: result.data,
        model: result.model,
        latencyMs,
        correlationId,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const cancelled = outcomeForError(signal);
      const timings = call.finish(cancelled ?? "error");
      return this.credit.handleProviderError({
        error,
        reservationId,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        ...(cancelled !== undefined ? { outcome: cancelled } : {}),
        timings,
      });
    }
  }

  async runStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const result = await this.runStructured(opts, correlationId, metrics);
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
  }

  async runStructuredWithImage<T>(
    opts: InvokeStructuredWithImageOpts<T>,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeResult<T>> {
    const call = this.metricsFor(opts, metrics);
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      call.finish("context_too_large");
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
    }

    const signal = resolveSignal(opts.signal);
    if (signal?.aborted === true) {
      call.finish("cancelled");
      return cancelledFailure(correlationId);
    }

    const reserveMilli = charge ? getCatalogEstimateMilli(feature) : 0;
    let reservationId = 0;

    if (charge) {
      const reserveResult = await this.credit.reserveCredits(
        reserveMilli,
        actor,
        feature,
        correlationId,
      );
      if (!reserveResult.reserved) {
        call.finish(reserveResult.kind);
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      }
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeStructuredWithImageWithUsage({
          model: tier ?? "fast",
          schema: opts.schema,
          schemaName: feature.replace(/[^a-z0-9]/gi, "_"),
          system: prompt.system,
          user: prompt.user,
          images: opts.images,
          maxTokens: boundedMaxTokens(maxTokens),
          onRetry: () => call.retried(),
          ...(signal !== undefined ? { signal } : {}),
        }),
      );

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      const timings = call.finish("ok", {
        model: result.model,
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        creditsMilli: milliCredits,
        costUsd,
      });

      await this.credit.settleAndTrack({
        reservationId,
        charge: charge ? { milli: reserveMilli } : undefined,
        model: result.model,
        usage,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        outcome: "ok",
        actualMilli: milliCredits,
        costUsd,
        timings,
      });

      return {
        ok: true,
        data: result.data,
        model: result.model,
        latencyMs,
        correlationId,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const cancelled = outcomeForError(signal);
      const timings = call.finish(cancelled ?? "error");
      return this.credit.handleProviderError({
        error,
        reservationId,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        ...(cancelled !== undefined ? { outcome: cancelled } : {}),
        timings,
      });
    }
  }

  async runText(
    opts: InvokeTextOpts,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeResult<string>> {
    const call = this.metricsFor(opts, metrics);
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      call.finish("context_too_large");
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
    }

    const signal = resolveSignal(opts.signal);
    if (signal?.aborted === true) {
      call.finish("cancelled");
      return cancelledFailure(correlationId);
    }

    const reserveMilli = charge ? getCatalogEstimateMilli(feature) : 0;
    let reservationId = 0;

    if (charge) {
      const reserveResult = await this.credit.reserveCredits(
        reserveMilli,
        actor,
        feature,
        correlationId,
      );
      if (!reserveResult.reserved) {
        call.finish(reserveResult.kind);
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      }
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await call.provider(() =>
        this.llm.invokeTextWithUsage({
          model: tier ?? "fast",
          system: prompt.system,
          user: prompt.user,
          maxTokens: boundedMaxTokens(maxTokens),
          onRetry: () => call.retried(),
          ...(signal !== undefined ? { signal } : {}),
        }),
      );

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      const timings = call.finish("ok", {
        model: result.model,
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        creditsMilli: milliCredits,
        costUsd,
      });

      await this.credit.settleAndTrack({
        reservationId,
        charge: charge ? { milli: reserveMilli } : undefined,
        model: result.model,
        usage,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        outcome: "ok",
        actualMilli: milliCredits,
        costUsd,
        timings,
      });

      return {
        ok: true,
        data: result.text,
        model: result.model,
        latencyMs,
        correlationId,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const cancelled = outcomeForError(signal);
      const timings = call.finish(cancelled ?? "error");
      return this.credit.handleProviderError({
        error,
        reservationId,
        actor,
        feature,
        prompt: opts.prompt,
        correlationId,
        latencyMs,
        ...(cancelled !== undefined ? { outcome: cancelled } : {}),
        timings,
      });
    }
  }

  async runTextWithUsage(
    opts: InvokeTextOpts,
    correlationId: string,
    metrics?: AiCallMetrics,
  ): Promise<AiInvokeWithUsageResult<string>> {
    const result = await this.runText(opts, correlationId, metrics);
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
  }
}
