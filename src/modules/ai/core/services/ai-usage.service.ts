import { Inject, Injectable } from "@nestjs/common";
import { aiUsageLogs } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";

export interface TrackAiUsageParams {
  orgId: string;
  userId?: string | null;
  feature: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  metadata?: Record<string, unknown>;
  latencyMs?: number;
  correlationId?: string;
  outcome?: string;
  creditsMilli?: number;
}

@Injectable()
export class AiUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async track(params: TrackAiUsageParams): Promise<void> {
    const { orgId, userId, feature, model, metadata, latencyMs, correlationId, outcome } = params;
    const promptTokens = params.promptTokens ?? 0;
    const completionTokens = params.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    const { costUsd } = computeTokenCharge(model, promptTokens, completionTokens);
    const estimatedCostUsd = costUsd.toFixed(6);
    const creditsMilli = params.creditsMilli ?? 0;

    try {
      await this.db.insert(aiUsageLogs).values({
        orgId,
        userId: userId ?? null,
        feature,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        creditsMilli,
        metadata: metadata ?? null,
        latencyMs: latencyMs ?? null,
        correlationId: correlationId ?? null,
        outcome: outcome ?? null,
      });
    } catch (error) {
      logger.error("Failed to track AI usage", { error, orgId, feature });
    }
  }
}
