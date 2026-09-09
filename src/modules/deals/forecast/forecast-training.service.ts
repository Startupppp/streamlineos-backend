import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { crmDealForecastModels, crmDealForecastScores } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import {
  FORECAST_FEATURE_SPEC_VERSION,
  assembleDealFeatures,
} from "./deal-forecast-features";
import { movesBefore, stageAt } from "./training-examples";
import {
  DEFAULT_RIDGE,
  fitLogisticModel,
  scoreWithModel,
  type DealScore,
  type FittedModel,
  type TrainingExample,
} from "./logistic-regression";
import {
  chronologicalSplit,
  evaluate,
  type ForecastMetrics,
  type Prediction,
} from "./forecast-metrics";
import {
  HOLDOUT_FRACTION,
  acceptModel,
  assessForecastHistory,
  type ForecastBasis,
  type ForecastReadiness,
  type NaiveReason,
} from "./forecast-cold-start";
import {
  featureValuesToRecord,
  fromStoredMetrics,
  rehydrateModel,
  toStoredMetrics,
} from "./forecast-model-store";
import {
  ForecastCorpusService,
  type ClosedCorpus,
  type OpenDealCorpusRow,
  type StageVocabulary,
} from "./forecast-corpus.service";

/**
 * The thing that was missing.
 *
 * `fitLogisticModel`, `scoreWithModel`, `acceptModel` and both forecast tables
 * have existed for a while with no caller outside their own specs, so
 * `DealsAnalyticsService.forecastBasis` could only ever answer "naive-weighted",
 * and its docblock says so in as many words: "the learned arm turns on when a
 * trainer does, not before." This is that trainer.
 *
 * The single most important property of this file is that it is willing to
 * produce nothing. A training run that fits a model, evaluates it and then
 * refuses to store it is a successful run — `acceptModel` is consulted before
 * anything is written, and a rejected model leaves the tenant exactly where they
 * were, with a reason that says which gate it failed. Shipping a model that
 * cannot beat the tenant's own stage percentages would put a confident number in
 * front of somebody planning a quarter around it, which is the specific harm the
 * whole cold-start file exists to prevent.
 *
 * Nothing here decides what a good model is. The floor is
 * `FORECAST_HISTORY_REQUIREMENT`, the gates are `FORECAST_ACCEPTANCE`, the
 * holdout is `chronologicalSplit`, and the vector is `assembleDealFeatures`.
 * This service decides only *when* to ask and *what to do with the answer*.
 */

export interface TrainingRejected {
  readonly trained: false;
  readonly reason: NaiveReason;
  readonly readiness: ForecastReadiness;
  /** Present whenever a fit actually ran, so a rejection can be argued with. */
  readonly learned: ForecastMetrics | null;
  readonly naive: ForecastMetrics | null;
}

export interface TrainingAccepted {
  readonly trained: true;
  readonly modelId: string;
  readonly readiness: ForecastReadiness;
  readonly trainingDeals: number;
  readonly holdoutDeals: number;
  readonly learned: ForecastMetrics;
  readonly naive: ForecastMetrics;
  readonly scored: number;
}

export type TrainingAttempt = TrainingAccepted | TrainingRejected;

export interface DealForecastScore {
  readonly dealId: number;
  readonly probability: number;
  readonly intervalLower: number;
  readonly intervalUpper: number;
  readonly expectedValueMinor: number;
  readonly asOf: string;
  readonly scoredAt: string;
  readonly factors: readonly {
    readonly feature: string;
    readonly value: number;
    readonly contribution: number;
    readonly direction: "increases" | "decreases";
  }[];
}

interface ActiveModel {
  readonly modelId: string;
  readonly model: FittedModel;
  readonly trainedAt: Date;
  readonly becameAvailableAt: Date;
  readonly trainingDeals: number;
  readonly holdoutDeals: number;
  readonly learned: ForecastMetrics;
  readonly naive: ForecastMetrics;
}

@Injectable()
export class ForecastTrainingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly corpus: ForecastCorpusService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Fit, judge, and store only if it earned it.
   *
   * The order is load → gate on history → assemble → split → fit → evaluate →
   * accept → write, and every one of those can end the run. Nothing is written
   * before the verdict, so an interrupted run leaves the previous model in place
   * rather than a half-superseded one.
   */
  async train(orgId: string, now: Date = new Date()): Promise<TrainingAttempt> {
    const closed = await this.corpus.loadClosedCorpus(orgId, now);

    let won = 0;
    for (const row of closed.rows) if (row.record.outcome === "won") won += 1;
    const readiness = assessForecastHistory({ won, lost: closed.rows.length - won });

    if (!readiness.ready)
      return { trained: false, reason: "insufficient-history", readiness, learned: null, naive: null };

    const examples: TrainingExample[] = closed.rows.map((row) => ({
      dealId: row.record.dealId,
      closedAt: row.record.closedAt,
      outcome: row.record.outcome,
      values: assembleDealFeatures({
        asOf: row.asOf,
        /**
         * The stage the deal was in a horizon before it closed, not the terminal
         * one it is sitting in now. Reading `row.snapshot.stage` here would hand
         * every example the answer in its most legible form.
         */
        deal: { ...row.snapshot, stage: stageAt(row.timeline.moves, row.asOf, row.snapshot.stage) },
        timeline: {
          moves: movesBefore(row.timeline.moves, row.asOf),
          activityCount: row.timeline.activityCount,
          lastActivityAt: row.timeline.lastActivityAt,
        },
        stageProbabilities: closed.stages.stageProbabilities,
        rates: closed.rates,
        /** Its own outcome is in `rates`; subtract it or the example is told the answer. */
        ownOutcome: row.record.outcome,
      }).values,
    }));

    const split = chronologicalSplit(examples, HOLDOUT_FRACTION);
    const model = fitLogisticModel(split.training, { ridge: DEFAULT_RIDGE });

    const learnedPredictions: Prediction[] = split.holdout.map((example) => ({
      probability: scoreWithModel(model, example.values).probability,
      won: example.outcome === "won",
    }));
    /**
     * The comparator is the tenant's own stage percentage for the stage the deal
     * was in at the same moment — the number the weighted pipeline already
     * shows. Where a stage carries no configured probability the feature falls
     * back to the organisation's base rate rather than to the product's flat
     * 20%, which makes the naive arm *stronger* than what is on screen today.
     * That is the conservative direction: a model that clears this bar has
     * beaten a better opponent than the one it is replacing.
     */
    const naivePredictions: Prediction[] = split.holdout.map((example) => ({
      probability: example.values.stageProbability,
      won: example.outcome === "won",
    }));

    const learned = evaluate(learnedPredictions);
    const naive = evaluate(naivePredictions);
    const verdict = acceptModel(learned, naive, model.converged);

    if (!verdict.accepted)
      return { trained: false, reason: verdict.reason, readiness, learned, naive };

    const modelId = await this.storeModel(orgId, model, learned, naive, split.holdout.length, now);
    const scored = await this.scoreOpenDeals(orgId, now, closed);
    /**
     * The pipeline read is cached, and it now weights by these scores. Leaving
     * the old entry in place would show the tenant a learned basis over totals
     * computed from stage percentages until the TTL expired.
     */
    await this.cache.del(CACHE_KEYS.dealsForecast(orgId));

    return {
      trained: true,
      modelId,
      readiness,
      trainingDeals: split.training.length,
      holdoutDeals: split.holdout.length,
      learned,
      naive,
      scored,
    };
  }

  /**
   * One active row per organisation, and the moment they first had one at all.
   *
   * `became_available_at` is carried forward from whatever it superseded rather
   * than reset on every retrain: crossing the threshold is a thing that happened
   * at a time, and a surface that says "learned since Tuesday" must not mean
   * "retrained on Tuesday".
   */
  private async storeModel(
    orgId: string,
    model: FittedModel,
    learned: ForecastMetrics,
    naive: ForecastMetrics,
    holdoutDeals: number,
    now: Date,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          modelId: crmDealForecastModels.crmDealForecastModelId,
          becameAvailableAt: crmDealForecastModels.becameAvailableAt,
        })
        .from(crmDealForecastModels)
        .where(
          and(
            eq(crmDealForecastModels.organizationId, orgId),
            eq(crmDealForecastModels.status, "active"),
          ),
        )
        .limit(1);

      if (existing !== undefined)
        await tx
          .update(crmDealForecastModels)
          .set({ status: "superseded" })
          .where(
            and(
              eq(crmDealForecastModels.organizationId, orgId),
              eq(crmDealForecastModels.crmDealForecastModelId, existing.modelId),
            ),
          );

      const [row] = await tx
        .insert(crmDealForecastModels)
        .values({
          organizationId: orgId,
          featureSpecVersion: model.specVersion,
          status: "active",
          trainedAt: now,
          becameAvailableAt: existing?.becameAvailableAt ?? now,
          trainingDeals: model.exampleCount,
          holdoutDeals,
          wonDeals: model.wonCount,
          lostDeals: model.exampleCount - model.wonCount,
          coefficients: {
            intercept: model.intercept,
            weights: featureValuesToRecord(model.weights),
            means: featureValuesToRecord(model.means),
            deviations: featureValuesToRecord(model.deviations),
            covariance: model.covariance.map((line) => [...line]),
          },
          evaluation: { learned: toStoredMetrics(learned), naive: toStoredMetrics(naive) },
          ridge: model.ridge,
          iterations: model.iterations,
          converged: model.converged,
        })
        .returning({ modelId: crmDealForecastModels.crmDealForecastModelId });

      if (row === undefined) throw new Error("forecast model insert returned no row");
      return row.modelId;
    });
  }

  /**
   * This organisation's model, or nothing.
   *
   * A row whose `feature_spec_version` differs from the running one is treated
   * as absent, not adapted. Coefficients fitted against one vocabulary applied
   * to another are numbers with no meaning that still look like a probability,
   * and the version exists precisely so nobody has to decide case by case.
   */
  private async activeModel(orgId: string): Promise<ActiveModel | null> {
    const [row] = await this.db
      .select()
      .from(crmDealForecastModels)
      .where(
        and(
          eq(crmDealForecastModels.organizationId, orgId),
          eq(crmDealForecastModels.status, "active"),
        ),
      )
      .orderBy(desc(crmDealForecastModels.trainedAt))
      .limit(1);

    if (row === undefined) return null;
    if (row.featureSpecVersion !== FORECAST_FEATURE_SPEC_VERSION) return null;

    const model = rehydrateModel(
      row.featureSpecVersion,
      row.coefficients,
      row.ridge,
      row.iterations,
      row.converged,
      row.trainingDeals,
      row.wonDeals,
    );
    if (model === null) {
      logger.error("stored forecast model could not be read", { orgId, modelId: row.crmDealForecastModelId });
      return null;
    }

    return {
      modelId: row.crmDealForecastModelId,
      model,
      trainedAt: row.trainedAt,
      becameAvailableAt: row.becameAvailableAt,
      trainingDeals: row.trainingDeals,
      holdoutDeals: row.holdoutDeals,
      learned: fromStoredMetrics(row.evaluation?.learned),
      naive: fromStoredMetrics(row.evaluation?.naive),
    };
  }

  /**
   * Score every open deal against the active model and store the result.
   *
   * The features are stored beside the answer. Without them a rep who disagrees
   * with a number has nothing to argue with: the deal has moved on by the time
   * they look, so recomputing gives a different answer and the disagreement
   * becomes unresolvable.
   *
   * A scoring-only pass still reads the closed corpus, and that is a deliberate
   * cost rather than an oversight. `repWinRate` and `sourceWinRate` are features,
   * so serving needs the same rates the fit was given; deriving them here from a
   * cheaper aggregate would create a second definition of the tenant's own win
   * rate, and the two would drift the moment either changed. One reader is what
   * keeps training and serving describing the same world.
   */
  async scoreOpenDeals(
    orgId: string,
    now: Date = new Date(),
    /** Passed by `train`, which has just read it; re-reading would double the work. */
    alreadyLoaded?: ClosedCorpus,
  ): Promise<number> {
    const active = await this.activeModel(orgId);
    if (active === null) return 0;

    const closed = alreadyLoaded ?? (await this.corpus.loadClosedCorpus(orgId, now));
    const stages = closed.stages;
    const open = await this.corpus.loadOpenDeals(orgId, stages);
    if (open.length === 0) return 0;

    const rows = open.map((deal) => this.scoreRow(orgId, active, deal, closed, stages, now));

    /**
     * One row per deal, replaced rather than appended: the history that matters
     * for accuracy is the closed deals themselves, and a score trail nobody
     * reads is a table that only grows.
     */
    const CHUNK = 200;
    let written = 0;
    for (let index = 0; index < rows.length; index += CHUNK) {
      const slice = rows.slice(index, index + CHUNK);
      await this.db
        .insert(crmDealForecastScores)
        .values(slice)
        .onConflictDoUpdate({
          target: [crmDealForecastScores.organizationId, crmDealForecastScores.dealId],
          /**
           * `excluded`, not the column. Naming the column on the right-hand side
           * of an upsert sets the value to itself — the statement succeeds, the
           * row is untouched, and every score silently stays at whatever the
           * first pass wrote.
           */
          set: {
            crmDealForecastModelId: sql`excluded.crm_deal_forecast_model_id`,
            asOf: sql`excluded.as_of`,
            scoredAt: sql`excluded.scored_at`,
            probability: sql`excluded.probability`,
            intervalLower: sql`excluded.interval_lower`,
            intervalUpper: sql`excluded.interval_upper`,
            expectedValueMinor: sql`excluded.expected_value_minor`,
            features: sql`excluded.features`,
            factors: sql`excluded.factors`,
          },
        });
      written += slice.length;
    }
    return written;
  }

  private scoreRow(
    orgId: string,
    active: ActiveModel,
    deal: OpenDealCorpusRow,
    closed: ClosedCorpus,
    stages: StageVocabulary,
    now: Date,
  ) {
    const vector = assembleDealFeatures({
      asOf: now,
      deal: deal.snapshot,
      timeline: {
        moves: movesBefore(deal.timeline.moves, now),
        activityCount: deal.timeline.activityCount,
        lastActivityAt: deal.timeline.lastActivityAt,
      },
      stageProbabilities: stages.stageProbabilities,
      rates: closed.rates,
      /** An open deal has no outcome to remove; leaving one out here would be a bug. */
      ownOutcome: null,
    });

    const score: DealScore = scoreWithModel(active.model, vector.values);

    return {
      organizationId: orgId,
      dealId: deal.snapshot.dealId,
      crmDealForecastModelId: active.modelId,
      asOf: now,
      scoredAt: now,
      probability: score.probability,
      intervalLower: score.interval.lower,
      intervalUpper: score.interval.upper,
      expectedValueMinor: Math.round(score.probability * deal.snapshot.valueMinor),
      features: featureValuesToRecord(vector.values),
      factors: score.factors.map((factor) => ({
        feature: factor.feature,
        value: factor.value,
        standardised: factor.standardised,
        contribution: factor.contribution,
        direction: factor.direction,
      })),
    };
  }

  /**
   * What the forecast on screen actually is.
   *
   * Called by the pipeline read, so it must be cheap and must never train.
   * "not-trained-yet" and "insufficient-history" are not interchangeable: the
   * first is our gap, the second is the tenant's, and a surface that renders
   * both as "not enough data" is lying to the first tenant.
   */
  async basisFor(orgId: string, readiness: ForecastReadiness): Promise<ForecastBasis> {
    const active = await this.activeModel(orgId);
    if (active === null)
      return {
        kind: "naive-weighted",
        reason: readiness.ready ? "not-trained-yet" : "insufficient-history",
        readiness,
      };

    return {
      kind: "learned",
      modelId: active.modelId,
      trainedAt: active.trainedAt.toISOString(),
      featureSpecVersion: FORECAST_FEATURE_SPEC_VERSION,
      trainingDeals: active.trainingDeals,
      holdoutDeals: active.holdoutDeals,
      holdout: active.learned,
      naiveHoldout: active.naive,
      becameAvailableAt: active.becameAvailableAt.toISOString(),
    };
  }

  /**
   * The basis on its own, for a surface that wants to explain the forecast
   * without asking for the whole pipeline.
   *
   * Readiness is counted rather than passed in here, because the caller is a
   * controller with nothing in hand. The pipeline read has the counts already
   * and uses the two-argument form instead — one arithmetic, two callers, no
   * second definition of "enough history".
   */
  async describeBasis(orgId: string, now: Date = new Date()): Promise<ForecastBasis> {
    const counts = await this.corpus.closedOutcomeCounts(orgId, now);
    return this.basisFor(orgId, assessForecastHistory(counts));
  }

  /**
   * The stored probabilities the pipeline read weights by, for the active model
   * only.
   *
   * Scores written under a superseded model stay in the table until that deal is
   * next scored, and must never be mixed with the current one's — two models'
   * probabilities summed into one total is a number produced by nothing.
   */
  async probabilitiesForOpenDeals(orgId: string): Promise<Map<number, number>> {
    const active = await this.activeModel(orgId);
    const byDeal = new Map<number, number>();
    if (active === null) return byDeal;

    const rows = await this.db
      .select({
        dealId: crmDealForecastScores.dealId,
        probability: crmDealForecastScores.probability,
      })
      .from(crmDealForecastScores)
      .where(
        and(
          eq(crmDealForecastScores.organizationId, orgId),
          eq(crmDealForecastScores.crmDealForecastModelId, active.modelId),
        ),
      );

    for (const row of rows) byDeal.set(row.dealId, Number(row.probability));
    return byDeal;
  }

  /** One deal's stored score, with the factors that produced it. */
  async scoreForDeal(orgId: string, dealId: number): Promise<DealForecastScore | null> {
    const active = await this.activeModel(orgId);
    if (active === null) return null;

    const [row] = await this.db
      .select()
      .from(crmDealForecastScores)
      .where(
        and(
          eq(crmDealForecastScores.organizationId, orgId),
          eq(crmDealForecastScores.dealId, dealId),
          eq(crmDealForecastScores.crmDealForecastModelId, active.modelId),
        ),
      )
      .limit(1);

    if (row === undefined) return null;

    return {
      dealId: row.dealId,
      probability: Number(row.probability),
      intervalLower: Number(row.intervalLower),
      intervalUpper: Number(row.intervalUpper),
      expectedValueMinor: Number(row.expectedValueMinor),
      asOf: row.asOf.toISOString(),
      scoredAt: row.scoredAt.toISOString(),
      factors: (row.factors ?? []).map((factor) => ({
        feature: factor.feature,
        value: factor.value,
        contribution: factor.contribution,
        direction: factor.direction,
      })),
    };
  }
}
