import { and, desc, eq } from "drizzle-orm";
import { crmDealForecastModels } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { FORECAST_FEATURE_SPEC_VERSION } from "../deal-forecast-features";
import type { FittedModel } from "../logistic-regression";
import type { ForecastMetrics } from "../forecast-metrics";
import {
  featureValuesToRecord,
  fromStoredMetrics,
  rehydrateModel,
  toStoredMetrics,
} from "../forecast-model-store";
import type { ActiveModel } from "../forecast-training.types";

/*
  The forecast model row: writing a newly accepted one in place of the active
  model, and reading the active one back. Moved out of
  `ForecastTrainingService` with the handle passed in.
*/

/**
 * One active row per organisation, and the moment they first had one at all.
 *
 * `became_available_at` is carried forward from whatever it superseded rather
 * than reset on every retrain: crossing the threshold is a thing that happened
 * at a time, and a surface that says "learned since Tuesday" must not mean
 * "retrained on Tuesday".
 */
export async function storeForecastModel(
  db: Db,
  orgId: string,
  model: FittedModel,
  learned: ForecastMetrics,
  naive: ForecastMetrics,
  holdoutDeals: number,
  now: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
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
export async function loadActiveModel(db: Db, orgId: string): Promise<ActiveModel | null> {
  const [row] = await db
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
