import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { logger } from "../../../../common/logger/logger.service";
import { EmbeddingsService, EMBEDDING_MODEL } from "../providers/embeddings.service";
import { AiUsageService } from "../services/ai-usage.service";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { type AiCreditLedger } from "./credit-ledger.interface";
import type {
  AiInvokeFailure,
  EmbedBatchOpts,
  EmbedBatchResult,
  EmbedQueryOpts,
  EmbedQueryResult,
} from "./ai-gateway.types";

const PROVIDER_UNAVAILABLE_MESSAGE = "Embedding provider is temporarily unavailable";

function estimateEmbedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Reservation =
  | { ok: true; reservationId: number }
  | { ok: false; failure: AiInvokeFailure };

export class AiGatewayEmbedHelper {
  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly ledger: AiCreditLedger,
    private readonly usageSvc: AiUsageService,
  ) {}

  async run(opts: EmbedQueryOpts, correlationId: string): Promise<EmbedQueryResult> {
    const { text, orgId, feature, charge } = opts;

    const reservation = await this.reserve(orgId, feature, charge, correlationId);
    if (!reservation.ok) return reservation.failure;

    const start = Date.now();
    let vector: number[];
    try {
      vector = await this.embeddings.embedQueryRaw(text);
    } catch (error: unknown) {
      return this.failAfterReservation(reservation.reservationId, orgId, feature, start, correlationId, error);
    }

    await this.meter(reservation.reservationId, orgId, feature, estimateEmbedTokens(text), charge, start, correlationId, 1);

    return { ok: true, vector, vectorLiteral: this.embeddings.toVectorLiteral(vector) };
  }

  async runBatch(opts: EmbedBatchOpts, correlationId: string): Promise<EmbedBatchResult> {
    const { texts, orgId, feature, charge } = opts;

    const reservation = await this.reserve(orgId, feature, charge, correlationId);
    if (!reservation.ok) return reservation.failure;

    const start = Date.now();
    let vectors: number[][];
    try {
      vectors = await this.embeddings.embedBatchRaw(texts);
    } catch (error: unknown) {
      return this.failAfterReservation(reservation.reservationId, orgId, feature, start, correlationId, error);
    }

    const promptTokens = texts.reduce((sum, t) => sum + estimateEmbedTokens(t), 0);
    await this.meter(reservation.reservationId, orgId, feature, promptTokens, charge, start, correlationId, texts.length);

    return { ok: true, vectors };
  }

  private async reserve(
    orgId: string,
    feature: string,
    charge: boolean,
    correlationId: string,
  ): Promise<Reservation> {
    if (!charge) return { ok: true, reservationId: 0 };
    try {
      const reserved = await this.ledger.reserve({
        orgId,
        userId: null,
        feature,
        credits: getReserveEstimateMilli(feature),
      });
      return { ok: true, reservationId: reserved.reservationId };
    } catch (error: unknown) {
      if (error instanceof InsufficientAiCreditsException)
        return {
          ok: false,
          failure: { ok: false, kind: "quota_exceeded", message: error.message, correlationId },
        };
      throw error;
    }
  }

  private async failAfterReservation(
    reservationId: number,
    orgId: string,
    feature: string,
    start: number,
    correlationId: string,
    cause: unknown,
  ): Promise<AiInvokeFailure> {
    await this.releaseReservation(reservationId, orgId, correlationId, cause);
    await this.usageSvc.track({
      orgId,
      feature,
      model: EMBEDDING_MODEL,
      latencyMs: Date.now() - start,
      correlationId,
      outcome: "error",
    });
    return {
      ok: false,
      kind: "provider_unavailable",
      message: PROVIDER_UNAVAILABLE_MESSAGE,
      correlationId,
    };
  }

  private async meter(
    reservationId: number,
    orgId: string,
    feature: string,
    promptTokens: number,
    charge: boolean,
    start: number,
    correlationId: string,
    batchSize: number,
  ): Promise<void> {
    const { costUsd, milliCredits } = charge
      ? computeTokenCharge(EMBEDDING_MODEL, promptTokens, 0)
      : { costUsd: 0, milliCredits: 0 };

    await this.settle(reservationId, orgId, promptTokens, milliCredits, costUsd, correlationId);

    await this.usageSvc.track({
      orgId,
      feature,
      model: EMBEDDING_MODEL,
      promptTokens,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      correlationId,
      outcome: "ok",
      creditsMilli: milliCredits,
      metadata: { tokenEstimate: true, batchSize },
    });
  }

  private async settle(
    reservationId: number,
    orgId: string,
    promptTokens: number,
    milliCredits: number,
    costUsd: number,
    correlationId: string,
  ): Promise<void> {
    if (reservationId === 0) return;
    try {
      await this.ledger.settle(reservationId, {
        orgId,
        actualMilli: milliCredits,
        model: EMBEDDING_MODEL,
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        costUsd,
      });
    } catch (error: unknown) {
      logger.error("AI embedding credit settlement failed", {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        reservationId,
        orgId,
        correlationId,
      });
    }
  }

  private async releaseReservation(
    reservationId: number,
    orgId: string,
    correlationId: string,
    cause: unknown,
  ): Promise<void> {
    if (reservationId === 0) return;
    try {
      await this.ledger.release(reservationId, "embedding_error", orgId);
    } catch (error: unknown) {
      logger.error("AI embedding credit release failed — reserved credits stay held until the sweep", {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        cause: cause instanceof Error ? cause.message : String(cause),
        reservationId,
        orgId,
        correlationId,
      });
    }
  }
}
