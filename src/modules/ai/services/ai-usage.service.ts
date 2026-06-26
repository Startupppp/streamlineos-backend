import { Inject, Injectable } from "@nestjs/common";
import { aiUsageLogs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";

const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-1.5-pro-latest": { input: 0.00125, output: 0.005 },
  "gemini-1.5-flash-latest": { input: 0.000075, output: 0.0003 },
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const rates = COST_PER_1K_TOKENS[model];
  if (!rates) return 0;
  return (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;
}

export interface TrackAiUsageParams {
  orgId: string;
  userId?: string | null;
  feature: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AiUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async track(params: TrackAiUsageParams): Promise<void> {
    const { orgId, userId, feature, model, metadata } = params;
    const promptTokens = params.promptTokens ?? 0;
    const completionTokens = params.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    const estimatedCostUsd = estimateCost(model, promptTokens, completionTokens).toFixed(6);

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
        metadata: metadata ?? null,
      });
    } catch (error) {
      logger.error("Failed to track AI usage", { error, orgId, feature });
    }
  }
}
