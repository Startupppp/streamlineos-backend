import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { ZodError } from "zod";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { logger } from "../../../../common/logger/logger.service";
import { type AiCreditLedger } from "./credit-ledger.interface";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import type {
  AiInvokeResult,
  AiInvokeFailure,
  AiInvokeBaseOpts,
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
  });
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

  async settleAndTrack(
    reservationId: number,
    charge: { milli: number } | undefined,
    model: string,
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    },
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    prompt: AiInvokeBaseOpts["prompt"],
    correlationId: string,
    latencyMs: number,
    outcome: "ok" | "error",
    actualMilli = 0,
    costUsd = 0,
  ): Promise<void> {
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

  async handleProviderError(
    error: unknown,
    reservationId: number,
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    prompt: AiInvokeBaseOpts["prompt"],
    correlationId: string,
    latencyMs: number,
  ): Promise<AiInvokeResult<never>> {
    if (error instanceof ZodError) {
      await this.releaseReservation(
        reservationId,
        "invalid_output",
        actor.orgId,
        correlationId,
      );
      await this.settleAndTrack(
        0,
        undefined,
        "unknown",
        { promptTokens: null, completionTokens: null, totalTokens: null },
        actor,
        feature,
        prompt,
        correlationId,
        latencyMs,
        "error",
      );
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

    await this.settleAndTrack(
      0,
      undefined,
      "unknown",
      { promptTokens: null, completionTokens: null, totalTokens: null },
      actor,
      feature,
      prompt,
      correlationId,
      latencyMs,
      "error",
    );

    return { ok: false, kind, message, correlationId };
  }
}
