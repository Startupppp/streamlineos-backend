import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { crmDealForecastScores } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
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
  type TrainingExample,
} from "./logistic-regression";
import { chronologicalSplit, evaluate, type Prediction } from "./forecast-metrics";
import {
  HOLDOUT_FRACTION,
  acceptModel,
  assessForecastHistory,
  type ForecastBasis,
  type ForecastReadiness,
} from "./forecast-cold-start";
import { ForecastCorpusService, type ClosedCorpus } from "./forecast-corpus.service";
import type { DealForecastScore, TrainingAttempt } from "./forecast-training.types";
import { loadActiveModel, storeForecastModel } from "./lib/forecast-model-records";
import { scoreRow, toDealForecastScore, writeScoreRows } from "./lib/forecast-scoring";

export type {
  DealForecastScore,
  TrainingAttempt,
} from "./forecast-training.types";

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
//
// The model row's write and read live in `lib/forecast-model-records.ts`;
// scoring one deal, writing the scores and mapping a stored score in
// `lib/forecast-scoring.ts`.

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

    const modelId = await storeForecastModel(this.db, orgId, model, learned, naive, split.holdout.length, now);
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
    const active = await loadActiveModel(this.db, orgId);
    if (active === null) return 0;

    const closed = alreadyLoaded ?? (await this.corpus.loadClosedCorpus(orgId, now));
    const stages = closed.stages;
    const open = await this.corpus.loadOpenDeals(orgId, stages);
    if (open.length === 0) return 0;

    const rows = open.map((deal) => scoreRow(orgId, active, deal, closed, stages, now));
    return writeScoreRows(this.db, rows);
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
    const active = await loadActiveModel(this.db, orgId);
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
    const active = await loadActiveModel(this.db, orgId);
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
    const active = await loadActiveModel(this.db, orgId);
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

    return toDealForecastScore(row);
  }
}
