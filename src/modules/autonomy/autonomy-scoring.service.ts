import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyShadowScores,
} from "../../db/schema";
import {
  type ShadowVerdict,
} from "../../db/schema/crm/autonomy-scoring";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { DataQualityHealthService } from "../data-quality/dataset-health.service";
import { capText, RECORDED_CONVERSATION_CHARS } from "./decision-record";
import {
  needsHumanReview,
  shouldShadowScore,
} from "./shadow-scoring";
import {
  autonomyReviewQueue,
  autonomyScoreboard,
  type AutonomyScoreboardDeps,
} from "./lib/autonomy-scoreboard";
import { erasePartyData as erasePartyDataFromStores } from "./lib/autonomy-erasure";
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

  private get scoreboardDeps(): AutonomyScoreboardDeps {
    return {
      db: this.db,
      datasetTrend: (organizationId, days) =>
        this.datasetHealth.trend(organizationId, days),
    };
  }

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
    patch: {
      shadowSampleRate?: number;
      shadowDailyCap?: number;
      holdWindowSeconds?: number;
      autoQuoteEnabled?: boolean;
    },
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

  /** @see autonomyScoreboard — the counts, the trend and the dataset health. */
  async scoreboard(organizationId: string, days = 30) {
    return autonomyScoreboard(this.scoreboardDeps, organizationId, days);
  }

  /** @see autonomyReviewQueue — disagreed decisions nobody has looked at. */
  async reviewQueue(organizationId: string, limit = 25) {
    return autonomyReviewQueue({ db: this.db }, organizationId, limit);
  }

  // ── Erasure ───────────────────────────────────────────────────────────────

  /** @see erasePartyData — removes one party from the measurement stores. */
  async erasePartyData(organizationId: string, partyId: string) {
    return erasePartyDataFromStores({ db: this.db }, organizationId, partyId);
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
