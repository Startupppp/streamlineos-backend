import { LlmService } from "../providers/llm.service";
import { redactSensitiveData } from "../redaction.util";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";
import { getReserveEstimateMilli as getCatalogEstimateMilli } from "../billing/ai-cost-catalog";
import { AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import type {
  AiInvokeResult,
  AiInvokeWithUsageResult,
  AiUsageMeta,
  InvokeStructuredOpts,
  InvokeStructuredWithImageOpts,
  InvokeTextOpts,
} from "./ai-gateway.types";

const MAX_CONTEXT_CHARS_DEFAULT = 200_000;

function contextExceedsLimit(prompt: { system: string; user: string }, max: number): boolean {
  return prompt.system.length + prompt.user.length > max;
}

export class AiGatewayRunnerHelper {
  constructor(
    private readonly llm: LlmService,
    private readonly credit: AiGatewayCreditHelper,
  ) {}

  async runStructured<T>(
    opts: InvokeStructuredOpts<T>,
    correlationId: string,
  ): Promise<AiInvokeResult<T>> {
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
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
      if (!reserveResult.reserved)
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await this.llm.invokeStructuredWithUsage({
        model: tier ?? "fast",
        schema: opts.schema,
        schemaName: feature.replace(/[^a-z0-9]/gi, "_"),
        system: prompt.system,
        user: prompt.user,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      await this.credit.settleAndTrack(
        reservationId,
        charge ? { milli: reserveMilli } : undefined,
        result.model,
        usage,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
        "ok",
        milliCredits,
        costUsd,
      );

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
      return this.credit.handleProviderError(
        error,
        reservationId,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
      );
    }
  }

  async runStructuredWithUsage<T>(
    opts: InvokeStructuredOpts<T>,
    correlationId: string,
  ): Promise<AiInvokeWithUsageResult<T>> {
    const result = await this.runStructured(opts, correlationId);
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
  ): Promise<AiInvokeResult<T>> {
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
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
      if (!reserveResult.reserved)
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await this.llm.invokeStructuredWithImageWithUsage({
        model: tier ?? "fast",
        schema: opts.schema,
        schemaName: feature.replace(/[^a-z0-9]/gi, "_"),
        system: prompt.system,
        user: prompt.user,
        images: opts.images,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      await this.credit.settleAndTrack(
        reservationId,
        charge ? { milli: reserveMilli } : undefined,
        result.model,
        usage,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
        "ok",
        milliCredits,
        costUsd,
      );

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
      return this.credit.handleProviderError(
        error,
        reservationId,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
      );
    }
  }

  async runText(
    opts: InvokeTextOpts,
    correlationId: string,
  ): Promise<AiInvokeResult<string>> {
    const { actor, feature, tier, maxTokens, maxContextChars, charge, redact = true } = opts;
    const prompt = redact
      ? {
          system: redactSensitiveData(opts.prompt.system),
          user: redactSensitiveData(opts.prompt.user),
        }
      : opts.prompt;

    if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
      return {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      };
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
      if (!reserveResult.reserved)
        return {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        };
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await this.llm.invokeTextWithUsage({
        model: tier ?? "fast",
        system: prompt.system,
        user: prompt.user,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      const { costUsd, milliCredits } = charge
        ? computeTokenCharge(
            result.model,
            usage.promptTokens ?? 0,
            usage.completionTokens ?? 0,
          )
        : { costUsd: 0, milliCredits: 0 };

      await this.credit.settleAndTrack(
        reservationId,
        charge ? { milli: reserveMilli } : undefined,
        result.model,
        usage,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
        "ok",
        milliCredits,
        costUsd,
      );

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
      return this.credit.handleProviderError(
        error,
        reservationId,
        actor,
        feature,
        opts.prompt,
        correlationId,
        latencyMs,
      );
    }
  }

  async runTextWithUsage(
    opts: InvokeTextOpts,
    correlationId: string,
  ): Promise<AiInvokeWithUsageResult<string>> {
    const result = await this.runText(opts, correlationId);
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
