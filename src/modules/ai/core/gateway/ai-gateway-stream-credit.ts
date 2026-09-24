import type { AiCreditLedger } from "./credit-ledger.interface";
import type { AiUsageService } from "../services/ai-usage.service";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import { logger } from "../../../../common/logger/logger.service";
import type { AiCallOutcome, AiCallTimings } from "../telemetry/ai-call-metrics";

export interface ReservationHandle {
  readonly reservationId: number;
  release: (reason: string) => void;
  markSettled: () => boolean;
}

export function makeReservationHandle(
  id: number,
  orgId: string,
  ledger: AiCreditLedger,
  feature: string,
): ReservationHandle {
  let disposed = false;
  return {
    reservationId: id,
    release(reason: string): void {
      if (disposed || id === 0) return;
      disposed = true;
      void ledger.release(id, reason, orgId).catch((err: unknown) => {
        logger.error("Failed to release AI credit reservation", {
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          reason,
          reservationId: id,
          feature,
          orgId,
        });
      });
    },
    markSettled(): boolean {
      if (disposed) return false;
      disposed = true;
      return true;
    },
  };
}

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
