import { redactSensitiveData } from "../redaction.util";
import {
  computeTokenCharge,
  milliToCredits,
} from "../billing/ai-model-pricing.constants";
import { getReserveEstimateMilli as getCatalogEstimateMilli } from "../billing/ai-cost-catalog";
import { AiCallMetrics, type AiCallOutcome } from "../telemetry/ai-call-metrics";
import { AI_CANCELLED_MESSAGE, AiGatewayCreditHelper } from "./ai-gateway-credit.helper";
import { getAmbientAiAbortSignal } from "../streaming/ai-request-abort";
import type {
  AiInvokeBaseOpts,
  AiInvokeFailure,
  AiInvokeResult,
  AiInvokeSuccess,
  AiInvokeWithUsageResult,
  AiTokenUsage,
  AiUsageMeta,
} from "./ai-gateway.types";

const MAX_CONTEXT_CHARS_DEFAULT = 200_000;
const MAX_OUTPUT_TOKENS_DEFAULT = 2_048;

export function boundedMaxTokens(requested: number | undefined): number {
  if (requested === undefined) return MAX_OUTPUT_TOKENS_DEFAULT;
  if (!Number.isFinite(requested)) return MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.max(1, Math.min(Math.floor(requested), MAX_OUTPUT_TOKENS_DEFAULT));
}

function contextExceedsLimit(prompt: { system: string; user: string }, max: number): boolean {
  return prompt.system.length + prompt.user.length > max;
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
  return explicit ?? getAmbientAiAbortSignal();
}

export interface RunnerPreflightProceed {
  readonly kind: "proceed";
  readonly prompt: { system: string; user: string };
  readonly signal: AbortSignal | undefined;
  readonly reserveMilli: number;
  readonly reservationId: number;
}

export interface RunnerPreflightReject {
  readonly kind: "reject";
  readonly failure: AiInvokeFailure;
}

export type RunnerPreflight = RunnerPreflightProceed | RunnerPreflightReject;

/**
 * The gauntlet every gateway runner walks before the provider is touched at all:
 * redaction, the context ceiling, an already-cancelled request, and the credit
 * reservation. Each rejection finishes the call's metrics with its own outcome, so a
 * refused prompt is never counted as a provider failure.
 */
export async function preflightCall(
  credit: AiGatewayCreditHelper,
  opts: AiInvokeBaseOpts,
  correlationId: string,
  call: AiCallMetrics,
): Promise<RunnerPreflight> {
  const { actor, feature, maxContextChars, charge, redact = true } = opts;
  const prompt = redact
    ? {
        system: redactSensitiveData(opts.prompt.system),
        user: redactSensitiveData(opts.prompt.user),
      }
    : opts.prompt;

  if (contextExceedsLimit(prompt, maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT)) {
    call.finish("context_too_large");
    return {
      kind: "reject",
      failure: {
        ok: false,
        kind: "context_too_large",
        message: `Prompt context exceeds the ${maxContextChars ?? MAX_CONTEXT_CHARS_DEFAULT}-character limit`,
        correlationId,
      },
    };
  }

  const signal = resolveSignal(opts.signal);
  if (signal?.aborted === true) {
    call.finish("cancelled");
    return {
      kind: "reject",
      failure: { ok: false, kind: "cancelled", message: AI_CANCELLED_MESSAGE, correlationId },
    };
  }

  const reserveMilli = charge ? getCatalogEstimateMilli(feature) : 0;

  if (charge) {
    const reserveResult = await credit.reserveCredits(
      reserveMilli,
      actor,
      feature,
      correlationId,
    );
    if (!reserveResult.reserved) {
      call.finish(reserveResult.kind);
      return {
        kind: "reject",
        failure: {
          ok: false,
          kind: reserveResult.kind,
          message: reserveResult.message,
          correlationId: reserveResult.correlationId,
        },
      };
    }
    return {
      kind: "proceed",
      prompt,
      signal,
      reserveMilli,
      reservationId: reserveResult.reservationId,
    };
  }

  return { kind: "proceed", prompt, signal, reserveMilli, reservationId: 0 };
}

export interface SettleSuccessInput<T> {
  readonly call: AiCallMetrics;
  readonly opts: AiInvokeBaseOpts;
  readonly correlationId: string;
  readonly reserveMilli: number;
  readonly reservationId: number;
  readonly startedAt: number;
  readonly model: string;
  readonly usage: AiTokenUsage;
  readonly data: T;
}

/**
 * Charges what the provider actually consumed, never the reserve ceiling: the
 * reservation is settled against the measured token count so an under-run refunds and
 * an overage debits.
 */
export async function settleSuccessfulCall<T>(
  credit: AiGatewayCreditHelper,
  input: SettleSuccessInput<T>,
): Promise<AiInvokeSuccess<T>> {
  const { call, opts, correlationId, reserveMilli, reservationId, startedAt, model, usage } = input;
  const { actor, feature, charge } = opts;
  const latencyMs = Date.now() - startedAt;

  const { costUsd, milliCredits } = charge
    ? computeTokenCharge(model, usage.promptTokens ?? 0, usage.completionTokens ?? 0)
    : { costUsd: 0, milliCredits: 0 };

  const timings = call.finish("ok", {
    model,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    creditsMilli: milliCredits,
    costUsd,
  });

  await credit.settleAndTrack({
    reservationId,
    charge: charge ? { milli: reserveMilli } : undefined,
    model,
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
    data: input.data,
    model,
    latencyMs,
    correlationId,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    },
  };
}

export interface SettleFailureInput {
  readonly call: AiCallMetrics;
  readonly opts: AiInvokeBaseOpts;
  readonly correlationId: string;
  readonly reservationId: number;
  readonly startedAt: number;
  readonly signal: AbortSignal | undefined;
  readonly error: unknown;
}

export async function settleFailedCall(
  credit: AiGatewayCreditHelper,
  input: SettleFailureInput,
): Promise<AiInvokeResult<never>> {
  const { call, opts, correlationId, reservationId, startedAt, signal, error } = input;
  const latencyMs = Date.now() - startedAt;
  const cancelled = outcomeForError(signal);
  const timings = call.finish(cancelled ?? "error");
  return credit.handleProviderError({
    error,
    reservationId,
    actor: opts.actor,
    feature: opts.feature,
    prompt: opts.prompt,
    correlationId,
    latencyMs,
    ...(cancelled !== undefined ? { outcome: cancelled } : {}),
    timings,
  });
}

/**
 * Re-prices a completed call for the `*WithUsage` variants, which return the metered
 * cost to the caller so the response can carry `aiUsage`.
 */
export function withUsageMeta<T>(result: AiInvokeResult<T>): AiInvokeWithUsageResult<T> {
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

  return { ok: true, data: result.data, aiUsage, correlationId: result.correlationId };
}
