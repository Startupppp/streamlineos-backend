import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  aiUsageLogs,
  autonomousDecisions,
  autonomyCorrections,
  autonomyShadowScores,
} from "../../db/schema";
import {
  type ShadowVerdict,
} from "../../db/schema/crm/autonomy-scoring";
import { DECISION_KINDS } from "../../db/schema/crm/autonomous-decisions";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { DataQualityHealthService } from "../data-quality/dataset-health.service";
import { capText, RECORDED_CONVERSATION_CHARS } from "./decision-record";
import {
  needsHumanReview,
  shouldShadowScore,
} from "./shadow-scoring";
import {
  buildShadowPrompt,
  shadowVerdictSchema,
  SHADOW_FEATURE,
  SHADOW_PROMPT_KEY,
  SHADOW_PROMPT_VERSION,
  SHADOW_SYSTEM_PROMPT,
  type ShadowVerdictResult,
} from "./shadow-scorer.schemas";
import { AutonomySettingsService } from "./autonomy-settings.service";

/**
 * Measuring a system that acts without asking.
 *
 * With no approval gate, the numbers here are not reporting — they are the
 * safety mechanism. A tenant deciding whether to enable an action type has
 * nothing else to go on, and an operator has nothing else to notice a
 * regression with.
 */
@Injectable()
export class AutonomyScoringService {
  private readonly logger = new Logger("AutonomyScoring");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly datasetHealth: DataQualityHealthService,
    private readonly settings: AutonomySettingsService,
  ) {}

  // ── Settings ──────────────────────────────────────────────────────────────

  /**
   * The organisation's dials, or the documented defaults.
   *
   * A tenant with no row is not misconfigured — it is a tenant that never
   * changed anything, and it must behave identically to one that explicitly set
   * the defaults.
   */
  settingsFor(organizationId: string) {
    return this.settings.settingsFor(organizationId);
  }

  updateSettings(
    organizationId: string,
    patch: { shadowSampleRate?: number; shadowDailyCap?: number; holdWindowSeconds?: number },
  ) {
    return this.settings.updateSettings(organizationId, patch);
  }

  // ── The second pass ───────────────────────────────────────────────────────

  /**
   * Give one decision a second opinion, if it is one of the sampled.
   *
   * Returns quietly when it is not — the caller is a workflow step, and a step
   * that throws because nothing needed doing would retry forever.
   */
  async scoreDecision(organizationId: string, decisionId: string): Promise<void> {
    const [decision] = await this.db
      .select({
        kind: autonomousDecisions.kind,
        outcome: autonomousDecisions.outcome,
        confidence: autonomousDecisions.confidence,
        summary: autonomousDecisions.summary,
        inputs: autonomousDecisions.inputs,
        decision: autonomousDecisions.decision,
      })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      )
      .limit(1);

    if (!decision) return;

    const settings = await this.settingsFor(organizationId);
    const scoredToday = await this.scoredTodayCount(organizationId);

    const sampling = shouldShadowScore({
      decisionId,
      kind: decision.kind,
      outcome: decision.outcome,
      confidence: decision.confidence,
      settings,
      scoredToday,
    });

    if (!sampling.score) return;

    /**
     * The same cap the writer applied, not a looser one.
     *
     * `RECORDED_CONVERSATION_CHARS` is the authority: the scorer can only ever
     * see what was written to `inputs`, so a larger number here is not a more
     * generous limit, it is a limit that never applies. This still runs, for the
     * rows written before that cap existed and for anything hand-edited.
     */
    const conversation = capText(
      String((decision.inputs as Record<string, unknown> | null)?.conversation ?? ""),
      RECORDED_CONVERSATION_CHARS,
    );

    // No context, no provider call. There is nothing to second-guess.
    if (conversation.trim().length === 0) return;

    let verdict: ShadowVerdict = "failed";
    let result: ShadowVerdictResult | null = null;
    let model: string | null = null;

    const invoked = await this.gateway.invokeStructuredWithUsage<ShadowVerdictResult>({
      actor: { orgId: organizationId, userId: null },
      feature: SHADOW_FEATURE,
      // The cheap tier, always. A second opinion that costs more than the
      // decision is a second opinion nobody leaves switched on.
      tier: "fast",
      schema: shadowVerdictSchema,
      charge: true,
      prompt: {
        system: SHADOW_SYSTEM_PROMPT,
        user: buildShadowPrompt({
          conversation,
          decisionSummary: decision.summary ?? "(no summary recorded)",
          decisionDetail: JSON.stringify(decision.decision ?? {}),
        }),
        promptKey: SHADOW_PROMPT_KEY,
        promptVersion: SHADOW_PROMPT_VERSION,
      },
    });

    if (invoked.ok) {
      result = invoked.data;
      verdict = invoked.data.verdict;
      model = invoked.aiUsage.model;
    } else {
      this.logger.warn(`shadow score did not complete for ${decisionId}: ${invoked.kind}`);
    }

    await this.db
      .insert(autonomyShadowScores)
      .values({
        organizationId,
        autonomousDecisionId: decisionId,
        kind: decision.kind,
        verdict,
        score: result?.score ?? null,
        rationale: result?.rationale ?? null,
        model,
        promptVersion: String(SHADOW_PROMPT_VERSION),
        needsReview: needsHumanReview(verdict, decision.confidence, decision.kind),
      })
      // Scoring the same decision twice would let a replayed workflow
      // double-count a disagreement and move the scoreboard on no new
      // information. A repeat is a no-op, not a conflict.
      .onConflictDoNothing({
        target: [
          autonomyShadowScores.organizationId,
          autonomyShadowScores.autonomousDecisionId,
        ],
      });
  }

  private async scoredTodayCount(organizationId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [row] = await this.db
      .select({ n: count() })
      .from(autonomyShadowScores)
      .where(
        and(
          eq(autonomyShadowScores.organizationId, organizationId),
          gte(autonomyShadowScores.createdAt, startOfDay),
        ),
      );

    return row?.n ?? 0;
  }

  // ── The scoreboard ────────────────────────────────────────────────────────

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
  async scoreboard(organizationId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const [taken, corrected, shadow, spend, dataset] = await Promise.all([
      this.db
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

      this.db
        .select({ kind: autonomyCorrections.kind, n: count() })
        .from(autonomyCorrections)
        .where(
          and(
            eq(autonomyCorrections.organizationId, organizationId),
            gte(autonomyCorrections.createdAt, since),
          ),
        )
        .groupBy(autonomyCorrections.kind),

      this.db
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

      this.db
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
      this.datasetHealth.trend(organizationId, days),
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
  async reviewQueue(organizationId: string, limit = 25) {
    return this.db
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

  // ── Erasure ───────────────────────────────────────────────────────────────

  /**
   * Remove everything about one party from the measurement stores.
   *
   * Evaluation datasets are within the scope of an erasure request, and the
   * corrections that feed them carry the customer's own words. Erasure that
   * reaches the CRM record but leaves the training material behind is nominal
   * rather than complete.
   *
   * This is deliberately a separate path from `purge-user.mjs`, which deletes
   * rows referencing a *user account* — an employee. The subject of an erasure
   * request is the person on the other side of the conversation, and nothing
   * about them is a foreign key.
   *
   * The decision rows themselves survive with their free text cleared. An audit
   * trail that loses the record of an action is a different kind of failure, and
   * the identifiers left behind resolve to nobody once the party is gone.
   */
  async erasePartyData(organizationId: string, partyId: string) {
    const decisions = await this.db
      .select({ id: autonomousDecisions.autonomousDecisionId })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.partyId, partyId),
        ),
      );

    if (decisions.length === 0) return { decisions: 0, corrections: 0, scores: 0 };

    const ids = decisions.map((d) => d.id);

    const [corrections, scores] = await Promise.all([
      this.db
        .delete(autonomyCorrections)
        .where(
          and(
            eq(autonomyCorrections.organizationId, organizationId),
            inArray(autonomyCorrections.autonomousDecisionId, ids),
          ),
        )
        .returning({ id: autonomyCorrections.autonomyCorrectionId }),
      this.db
        .delete(autonomyShadowScores)
        .where(
          and(
            eq(autonomyShadowScores.organizationId, organizationId),
            inArray(autonomyShadowScores.autonomousDecisionId, ids),
          ),
        )
        .returning({ id: autonomyShadowScores.autonomyShadowScoreId }),
    ]);

    // The free text is what carries the person. The row stays so the action is
    // still auditable; what it considered and concluded does not.
    await this.db
      .update(autonomousDecisions)
      .set({ inputs: null, decision: null, summary: null })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          inArray(autonomousDecisions.autonomousDecisionId, ids),
        ),
      );

    return {
      decisions: ids.length,
      corrections: corrections.length,
      scores: scores.length,
    };
  }

  /** Mark one queue item as looked at. Does not change the decision itself. */
  async markReviewed(organizationId: string, userId: string, shadowScoreId: string) {
    const score = await this.db.query.autonomyShadowScores.findFirst({
      where: and(
        eq(autonomyShadowScores.organizationId, organizationId),
        eq(autonomyShadowScores.autonomyShadowScoreId, shadowScoreId),
      ),
      columns: { autonomyShadowScoreId: true },
    });
    if (!score) throw new NotFoundException("Shadow score not found");

    const updated = await this.db
      .update(autonomyShadowScores)
      .set({ reviewedAt: new Date(), reviewedByUserId: userId })
      .where(
        and(
          eq(autonomyShadowScores.organizationId, organizationId),
          eq(autonomyShadowScores.autonomyShadowScoreId, shadowScoreId),
          isNull(autonomyShadowScores.reviewedAt),
        ),
      )
      .returning({ id: autonomyShadowScores.autonomyShadowScoreId });

    return { reviewed: updated.length > 0 };
  }
}
