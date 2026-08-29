import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import { aiUsageLogs } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
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
      await runInTenantTransaction(this.db, (tx) => tx.insert(aiUsageLogs).values({
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
      }), { orgId });
    } catch (error) {
      logger.error("Failed to track AI usage", { error, orgId, feature });
    }
  }

  /**
   * F6. One recorded call, by the gateway's own correlation id.
   *
   * This exists so that feedback about an AI answer can be attached to the call
   * that produced it **on the server's figures rather than the client's**. A
   * browser echoing back "this cost 3 credits" is a number nobody should store,
   * and a correlation id that names no call at all is a report about something
   * that never happened — most likely a mistake, possibly a way to
   * manufacture evidence against another organisation's usage.
   *
   * `null` therefore means "no such call for this organisation", and the caller
   * is expected to refuse rather than to fall back to what it was told.
   *
   * The window is what makes this cheap. `ai_usage_logs` carries no index on
   * `correlation_id`, but it carries `(org_id, created_at)` — so bounding the
   * search to recent history turns an organisation-wide scan into an indexed
   * range read. Feedback arrives while somebody is looking at an answer, so a
   * day is generous; older than that and there is nothing to attach to.
   */
  async findRecentCall(
    orgId: string,
    correlationId: string,
    withinMs = 24 * 60 * 60 * 1000,
  ): Promise<{
    feature: string;
    model: string;
    totalTokens: number;
    creditsMilli: number;
    estimatedCostUsd: string | null;
    createdAt: Date;
  } | null> {
    const since = new Date(Date.now() - withinMs);
    const [row] = await this.db
      .select({
        feature: aiUsageLogs.feature,
        model: aiUsageLogs.model,
        totalTokens: aiUsageLogs.totalTokens,
        creditsMilli: aiUsageLogs.creditsMilli,
        estimatedCostUsd: aiUsageLogs.estimatedCostUsd,
        createdAt: aiUsageLogs.createdAt,
      })
      .from(aiUsageLogs)
      .where(
        and(
          eq(aiUsageLogs.orgId, orgId),
          gte(aiUsageLogs.createdAt, since),
          eq(aiUsageLogs.correlationId, correlationId),
        ),
      )
      .orderBy(desc(aiUsageLogs.createdAt))
      .limit(1);
    return row ?? null;
  }
}
