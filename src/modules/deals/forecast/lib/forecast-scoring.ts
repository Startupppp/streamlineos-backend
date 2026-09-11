import { sql } from "drizzle-orm";
import { crmDealForecastScores } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { assembleDealFeatures } from "../deal-forecast-features";
import { movesBefore } from "../training-examples";
import { scoreWithModel, type DealScore } from "../logistic-regression";
import { reportableProbability } from "../forecast-cold-start";
import { featureValuesToRecord } from "../forecast-model-store";
import type {
  ClosedCorpus,
  OpenDealCorpusRow,
  StageVocabulary,
} from "../forecast-corpus.service";
import type { ActiveModel, DealForecastScore } from "../forecast-training.types";

/*
  Scoring open deals against the active model: one deal's stored row, the
  chunked upsert that writes them, and a stored row as the API returns it.
  Moved out of `ForecastTrainingService`; `scoreOpenDeals` still decides when.
*/

export function scoreRow(
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

  /**
   * Stored inside the band the product is willing to assert, not raw.
   *
   * `scoreWithModel` is left alone on purpose — the acceptance gate reads its
   * output directly, and a model whose worst predictions were pulled towards
   * the middle before being scored would look better calibrated than it is.
   * The band belongs here, where a number stops being arithmetic and becomes
   * a claim on a screen.
   */
  const probability = reportableProbability(score.probability);

  return {
    organizationId: orgId,
    dealId: deal.snapshot.dealId,
    crmDealForecastModelId: active.modelId,
    asOf: now,
    scoredAt: now,
    probability,
    intervalLower: reportableProbability(score.interval.lower),
    intervalUpper: reportableProbability(score.interval.upper),
    expectedValueMinor: Math.round(probability * deal.snapshot.valueMinor),
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

/** Writes the scored rows; returns how many were written. */
export async function writeScoreRows(
  db: Db,
  rows: readonly ReturnType<typeof scoreRow>[],
): Promise<number> {
  /**
   * One row per deal, replaced rather than appended: the history that matters
   * for accuracy is the closed deals themselves, and a score trail nobody
   * reads is a table that only grows.
   */
  const CHUNK = 200;
  let written = 0;
  for (let index = 0; index < rows.length; index += CHUNK) {
    const slice = rows.slice(index, index + CHUNK);
    await db
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

/** One stored score, with the factors that produced it, as `scoreForDeal` returns it. */
export function toDealForecastScore(
  row: typeof crmDealForecastScores.$inferSelect,
): DealForecastScore {
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
