/**
 * The scoreboard and the review queue — the two read surfaces of autonomy
 * measurement.
 *
 * These are the half of `AutonomyScoringService` a tenant *looks at*. Nothing
 * here calls a provider, spends a credit or writes a row; the scoring pass and
 * the erasure path do all three, and each of those failure modes has nothing to
 * say about the other. The section header these functions moved out from had
 * already drawn this line.
 */
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  aiUsageLogs,
  autonomousDecisions,
  autonomyCorrections,
  autonomyShadowScores,
} from "../../../db/schema";
import { DECISION_KINDS } from "../../../db/schema/crm/autonomous-decisions";
import type { DatasetHealthTrend } from "../../data-quality/dataset-health.service";

export interface AutonomyScoreboardDeps {
  readonly db: Db;
  /**
   * Bound `DataQualityHealthService.trend`. A closure rather than the service
   * itself so this lib carries no dependency on the data-quality module.
   */
  readonly datasetTrend: (
    organizationId: string,
    days: number,
  ) => Promise<DatasetHealthTrend>;
}

/**
 * Real counts per action type, the trend, and the state of the data all of it
 * runs on.
 *
 * Corrections are counted from `autonomy_corrections`, which is attributed to
 * a specific decision — counting edits that merely happened near an action in
 * time gives a rate that looks real and is not.
 *
 * Dataset health is here rather than on a data-quality surface of its own, and
 * that placement is the point. A correction rate and a dataset-health number
 * are the same question asked twice: an autonomous system reading contradictory
 * customer records will be corrected more often, and a manager looking at a
 * rising correction rate needs to see, in the same glance, whether the cause is
 * the model or the data underneath it. Two scoreboards would put those two
 * halves in two habits, and nobody would hold them side by side.
 */
export async function autonomyScoreboard(
  deps: AutonomyScoreboardDeps,
  organizationId: string,
  days = 30,
) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [taken, corrected, shadow, spend, dataset] = await Promise.all([
    deps.db
      .select({ kind: autonomousDecisions.kind, n: count() })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.outcome, "applied"),
          gte(autonomousDecisions.decidedAt, since),
        ),
      )
      .groupBy(autonomousDecisions.kind),

    deps.db
      .select({ kind: autonomyCorrections.kind, n: count() })
      .from(autonomyCorrections)
      .where(
        and(
          eq(autonomyCorrections.organizationId, organizationId),
          gte(autonomyCorrections.createdAt, since),
        ),
      )
      .groupBy(autonomyCorrections.kind),

    deps.db
      .select({
        kind: autonomyShadowScores.kind,
        verdict: autonomyShadowScores.verdict,
        n: count(),
      })
      .from(autonomyShadowScores)
      .where(
        and(
          eq(autonomyShadowScores.organizationId, organizationId),
          gte(autonomyShadowScores.createdAt, since),
        ),
      )
      .groupBy(autonomyShadowScores.kind, autonomyShadowScores.verdict),

    deps.db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageLogs.totalTokens}), 0)::int`,
        estimatedCostUsd: sql<string>`COALESCE(SUM(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        calls: count(),
      })
      .from(aiUsageLogs)
      .where(
        and(
          eq(aiUsageLogs.orgId, organizationId),
          gte(aiUsageLogs.createdAt, since),
          sql`${aiUsageLogs.feature} LIKE 'crm.autonomy%'`,
        ),
      ),

    /**
     * The same window as everything else on this card, deliberately. A health
     * trend over thirty days beside a correction rate over seven would invite
     * a causal reading of two figures that do not cover the same period.
     */
    deps.datasetTrend(organizationId, days),
  ]);

  const takenBy = new Map(taken.map((r) => [r.kind, r.n]));
  const correctedBy = new Map(corrected.map((r) => [r.kind, r.n]));

  const perKind = DECISION_KINDS.map((kind) => {
    const actions = takenBy.get(kind) ?? 0;
    const corrections = correctedBy.get(kind) ?? 0;
    const scores = shadow.filter((s) => s.kind === kind);
    const disagreed = scores.find((s) => s.verdict === "disagrees")?.n ?? 0;
    const scored = scores.reduce((total, s) => total + s.n, 0);

    return {
      kind,
      actions,
      corrections,
      /**
       * Null rather than zero when nothing has happened.
       *
       * A rate of 0% and "no data yet" mean opposite things to somebody
       * deciding whether to trust an action type, and rendering both as 0%
       * says the system is perfect at something it has never done.
       */
      correctionRate: actions > 0 ? corrections / actions : null,
      shadowScored: scored,
      shadowDisagreed: disagreed,
      shadowDisagreementRate: scored > 0 ? disagreed / scored : null,
    };
  });

  return {
    since: since.toISOString(),
    days,
    perKind,
    dataset,
    spend: {
      calls: spend[0]?.calls ?? 0,
      totalTokens: spend[0]?.totalTokens ?? 0,
      estimatedCostUsd: spend[0]?.estimatedCostUsd ?? "0",
    },
  };
}

/** Decisions a second pass disagreed with, that nobody has looked at. */
export async function autonomyReviewQueue(
  deps: Pick<AutonomyScoreboardDeps, "db">,
  organizationId: string,
  limit = 25,
) {
  return deps.db
    .select({
      autonomyShadowScoreId: autonomyShadowScores.autonomyShadowScoreId,
      autonomousDecisionId: autonomyShadowScores.autonomousDecisionId,
      kind: autonomyShadowScores.kind,
      verdict: autonomyShadowScores.verdict,
      score: autonomyShadowScores.score,
      rationale: autonomyShadowScores.rationale,
      createdAt: autonomyShadowScores.createdAt,
      decisionSummary: autonomousDecisions.summary,
      decidedAt: autonomousDecisions.decidedAt,
      confidence: autonomousDecisions.confidence,
    })
    .from(autonomyShadowScores)
    .innerJoin(
      autonomousDecisions,
      and(
        eq(autonomousDecisions.organizationId, autonomyShadowScores.organizationId),
        eq(
          autonomousDecisions.autonomousDecisionId,
          autonomyShadowScores.autonomousDecisionId,
        ),
      ),
    )
    .where(
      and(
        eq(autonomyShadowScores.organizationId, organizationId),
        eq(autonomyShadowScores.needsReview, true),
        isNull(autonomyShadowScores.reviewedAt),
      ),
    )
    .orderBy(desc(autonomyShadowScores.createdAt))
    .limit(Math.min(limit, 100));
}
