import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { ZodError } from "zod";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { logger } from "../../../../common/logger/logger.service";
import { type AiCreditLedger } from "./credit-ledger.interface";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import type { AiCallOutcome, AiCallTimings } from "../telemetry/ai-call-metrics";
import type {
  AiInvokeResult,
  AiInvokeFailure,
  AiInvokeBaseOpts,
  AiTokenUsage,
} from "./ai-gateway.types";

export type ReserveResult =
  | { reserved: true; reservationId: number }
  | {
      reserved: false;
      correlationId: string;
      kind: AiInvokeFailure["kind"];
      message: string;
    };

export interface StreamSettlement {
  reservationId: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  orgId: string;
  userId: string | null;
  feature: string;
  ttftMs?: number;
  appOverheadMs?: number;
  /** Queue wait, provider time, retries and cache state for the streamed turn. */
  timings?: AiCallTimings;
  outcome?: AiCallOutcome;
}

export async function settleStream(
  ledger: AiCreditLedger,
  usageSvc: Pick<AiUsageService, "track">,
  settlement: StreamSettlement,
): Promise<void> {
  const { reservationId, model, promptTokens, completionTokens, orgId, userId, feature, ttftMs, appOverheadMs } =
    settlement;
  const { costUsd, milliCredits } = computeTokenCharge(model, promptTokens, completionTokens);
  await ledger.settle(reservationId, {
    orgId,
    actualMilli: milliCredits,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd,
  });
  await usageSvc.track({
    orgId,
    userId,
    feature,
    model,
    promptTokens,
    completionTokens,
    creditsMilli: milliCredits,
    ttftMs,
    appOverheadMs,
    outcome: settlement.outcome ?? "ok",
    ...(settlement.timings ? { timings: settlement.timings } : {}),
  });
}

export interface SettleAndTrackInput {
  reservationId: number;
  charge: { milli: number } | undefined;
  model: string;
  usage: AiTokenUsage;
  actor: AiInvokeBaseOpts["actor"];
  feature: string;
  prompt: AiInvokeBaseOpts["prompt"];
  correlationId: string;
  latencyMs: number;
  outcome: AiCallOutcome;
  actualMilli?: number;
  costUsd?: number;
  timings?: AiCallTimings;
}

export interface HandleProviderErrorInput {
  error: unknown;
  reservationId: number;
  actor: AiInvokeBaseOpts["actor"];
  feature: string;
  prompt: AiInvokeBaseOpts["prompt"];
  correlationId: string;
  latencyMs: number;
  /** `cancelled` when the caller hung up; the provider did not fail. */
  outcome?: AiCallOutcome;
  timings?: AiCallTimings;
}

export class AiGatewayCreditHelper {
  constructor(
    private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
    private readonly audit: AuditService,
  ) {}

  async reserveCredits(
    milliAmount: number,
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    correlationId: string,
  ): Promise<ReserveResult> {
    try {
      const { reservationId } = await this.ledger.reserve({
        orgId: actor.orgId,
        userId: actor.userId,
        feature,
        credits: milliAmount,
      });
      return { reserved: true, reservationId };
    } catch (error) {
      if (error instanceof InsufficientAiCreditsException)
        return {
          reserved: false,
          correlationId,
          kind: "quota_exceeded",
          message: error.message,
        };
      throw error;
    }
  }

  async settleAndTrack(input: SettleAndTrackInput): Promise<void> {
    const {
      reservationId,
      charge,
      model,
      usage,
      actor,
      feature,
      prompt,
      correlationId,
      latencyMs,
      outcome,
      actualMilli = 0,
      costUsd = 0,
      timings,
    } = input;

    if (charge && reservationId !== 0) {
      // Awaited: this is the debit. Swallowing it silently loses revenue and,
      // once the caller opts out of the request transaction, would run with no
      // tenant context at all.
      try {
        await this.ledger.settle(reservationId, {
          orgId: actor.orgId,
          actualMilli,
          model,
          promptTokens: usage.promptTokens ?? undefined,
          completionTokens: usage.completionTokens ?? undefined,
          totalTokens: usage.totalTokens ?? undefined,
          costUsd,
        });
      } catch (error: unknown) {
        logger.error("AI credit settlement failed", {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          reservationId,
          orgId: actor.orgId,
          feature,
          correlationId,
        });
      }
    }

    await this.usageSvc.track({
      orgId: actor.orgId,
      userId: actor.userId,
      feature,
      model,
      promptTokens: usage.promptTokens ?? undefined,
      completionTokens: usage.completionTokens ?? undefined,
      latencyMs,
      correlationId,
      outcome,
      creditsMilli: actualMilli,
      ...(timings ? { timings } : {}),
    });

    this.audit.log({
      action: "ai.invoke",
      userId: actor.userId ?? "system",
      orgId: actor.orgId,
      metadata: {
        feature,
        model,
        promptKey: prompt.promptKey,
        promptVersion: prompt.promptVersion,
        correlationId,
        latencyMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        outcome,
      },
    });
  }

  async releaseReservation(
    reservationId: number,
    reason: string,
    orgId: string,
    correlationId: string,
  ): Promise<void> {
    if (reservationId === 0) return;
    try {
      await this.ledger.release(reservationId, reason, orgId);
    } catch (error: unknown) {
      logger.error(
        "AI credit release failed — reserved credits stay held until the sweep",
        {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          reservationId,
          orgId,
          reason,
          correlationId,
        },
      );
    }
  }

  async handleProviderError(input: HandleProviderErrorInput): Promise<AiInvokeResult<never>> {
    const { error, reservationId, actor, feature, prompt, correlationId, latencyMs, timings } = input;
    const noUsage: AiTokenUsage = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };

    if (error instanceof ZodError) {
      await this.releaseReservation(
        reservationId,
        "invalid_output",
        actor.orgId,
        correlationId,
      );
      await this.settleAndTrack({
        reservationId: 0,
        charge: undefined,
        model: "unknown",
        usage: noUsage,
        actor,
        feature,
        prompt,
        correlationId,
        latencyMs,
        outcome: input.outcome ?? "invalid_output",
        ...(timings ? { timings } : {}),
      });
      return {
        ok: false,
        kind: "invalid_output",
        message: "AI response did not match expected format",
        correlationId,
      };
    }

    await this.releaseReservation(
      reservationId,
      "provider_error",
      actor.orgId,
      correlationId,
    );

    const message =
      error instanceof ServiceUnavailableException
        ? error.message
        : "AI provider is temporarily unavailable";
    const kind: AiInvokeFailure["kind"] = message
      .toLowerCase()
      .includes("not configured")
      ? "not_configured"
      : "provider_unavailable";

    await this.settleAndTrack({
      reservationId: 0,
      charge: undefined,
      model: "unknown",
      usage: noUsage,
      actor,
      feature,
      prompt,
      correlationId,
      latencyMs,
      outcome: input.outcome ?? kind,
      ...(timings ? { timings } : {}),
    });

    return { ok: false, kind, message, correlationId };
  }
}
