import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import { aiUsageLogs } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import { getObservabilityContext } from "../../../../common/observability";
import type { AiCallOutcome, AiCallTimings } from "../telemetry/ai-call-metrics";

const CORRELATION_ID_MAX_LENGTH = 64;

/**
 * Defaulted at the single write site, so a caller that forgets it still produces
 * a row that joins back to the request — the streaming settle path had no way to
 * pass one at all, and every stream it billed landed with a null.
 */
function resolveCorrelationId(explicit: string | undefined): string | null {
  const candidate = explicit ?? getObservabilityContext()?.correlationId;
  if (candidate === undefined) return null;
  return candidate.length <= CORRELATION_ID_MAX_LENGTH ? candidate : null;
}

export interface TrackAiUsageParams {
  orgId: string;
  userId?: string | null;
  feature: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  metadata?: Record<string, unknown>;
  latencyMs?: number;
  ttftMs?: number;
  appOverheadMs?: number;
  correlationId?: string;
  outcome?: AiCallOutcome;
  creditsMilli?: number;
  /** Every measured phase at once, so a caller cannot record half of them. */
  timings?: AiCallTimings;
}

/**
 * The measured phases, flattened onto the row's metadata.
 *
 * `latency_ms` is the column and stays what it has always been — the wall clock
 * of the whole call. The split lives here because the phases are what tell an
 * operator whether a slow call was the provider, the queue or us, and a single
 * total answers none of those.
 */
function timingMetadata(timings: AiCallTimings): Record<string, number | boolean> {
  return {
    queueMs: timings.queueMs,
    appOverheadMs: timings.overheadMs,
    providerMs: timings.providerMs,
    ...(timings.ttftMs !== undefined ? { ttftMs: timings.ttftMs } : {}),
    retries: timings.retries,
    cacheHit: timings.cacheHit,
  };
}

@Injectable()
export class AiUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async track(params: TrackAiUsageParams): Promise<void> {
    const { orgId, userId, feature, model, latencyMs, outcome } = params;
    const correlationId = resolveCorrelationId(params.correlationId);
    const metadata: Record<string, unknown> = {
      ...(params.metadata ?? {}),
      ...(params.timings ? timingMetadata(params.timings) : {}),
    };
    if (params.ttftMs !== undefined) metadata["ttftMs"] = params.ttftMs;
    if (params.appOverheadMs !== undefined) metadata["appOverheadMs"] = params.appOverheadMs;
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
        correlationId,
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
