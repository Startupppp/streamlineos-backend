import {
  DEAL_FEATURE_NAMES,
  type DealFeatureName,
} from "./deal-forecast-features";
import type { FeatureValues, FittedModel } from "./logistic-regression";
import type {
  StoredCoefficients,
  StoredForecastMetrics,
} from "../../../db/schema/crm/deal-forecast";
import type { ForecastMetrics } from "./forecast-metrics";

/**
 * Getting a model out of the database and back into the shape that scores.
 *
 * The row stores plain JSON — `Record<string, number>` — because a jsonb column
 * has no opinion about which keys it holds. Rehydrating it means asserting that
 * every feature the current vocabulary names is present, and the only way to do
 * that without a cast is to write the fourteen reads out. That is deliberate:
 * the day a feature is added, this file stops compiling, which is exactly when
 * somebody should be thinking about what happens to models fitted before it.
 *
 * A missing key is not defaulted to zero. Zero is a real standardised value
 * meaning "average", so silently supplying it would turn a corrupt row into a
 * confident-looking forecast rather than a refusal.
 */

export function featureValuesFrom(
  read: (name: DealFeatureName) => number,
): FeatureValues {
  return {
    stageProbability: read("stageProbability"),
    logValue: read("logValue"),
    ageDays: read("ageDays"),
    currentStageDwellDays: read("currentStageDwellDays"),
    advanceCount: read("advanceCount"),
    regressionCount: read("regressionCount"),
    activityCount: read("activityCount"),
    daysSinceLastActivity: read("daysSinceLastActivity"),
    activitiesPerWeek: read("activitiesPerWeek"),
    daysToExpectedClose: read("daysToExpectedClose"),
    hasExpectedCloseDate: read("hasExpectedCloseDate"),
    expectedCloseOverdue: read("expectedCloseOverdue"),
    repWinRate: read("repWinRate"),
    sourceWinRate: read("sourceWinRate"),
  };
}

export function featureValuesToRecord(
  values: FeatureValues,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const name of DEAL_FEATURE_NAMES) record[name] = values[name];
  return record;
}

function requireNumbers(
  source: Record<string, number>,
): FeatureValues | null {
  for (const name of DEAL_FEATURE_NAMES)
    if (!Number.isFinite(source[name])) return null;
  return featureValuesFrom((name) => source[name] ?? 0);
}

/** A square numeric matrix of the width the design implies, or nothing. */
function requireCovariance(rows: number[][] | undefined): number[][] | null {
  const width = DEAL_FEATURE_NAMES.length + 1;
  if (!Array.isArray(rows) || rows.length !== width) return null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width) return null;
    for (const cell of row) if (!Number.isFinite(cell)) return null;
  }
  return rows;
}

/**
 * The stored row as a model, or null when it cannot be trusted to score.
 *
 * Null is returned rather than a throw because the caller's response to a model
 * it cannot read is to fall back to the weighted pipeline, which is a normal
 * product state and not an error. The refusal still has to be visible, so the
 * caller reports the naive reason rather than silently presenting one.
 */
export function rehydrateModel(
  specVersion: string,
  stored: StoredCoefficients,
  ridge: number,
  iterations: number,
  converged: boolean,
  exampleCount: number,
  wonCount: number,
): FittedModel | null {
  if (!Number.isFinite(stored?.intercept)) return null;
  const weights = requireNumbers(stored.weights ?? {});
  const means = requireNumbers(stored.means ?? {});
  const deviations = requireNumbers(stored.deviations ?? {});
  const covariance = requireCovariance(stored.covariance);
  if (weights === null || means === null || deviations === null || covariance === null)
    return null;

  return {
    specVersion,
    intercept: stored.intercept,
    weights,
    means,
    deviations,
    covariance,
    ridge,
    iterations,
    converged,
    exampleCount,
    wonCount,
  };
}

/** The metrics as the column holds them; the shape is identical by design. */
export function toStoredMetrics(metrics: ForecastMetrics): StoredForecastMetrics {
  return {
    count: metrics.count,
    brier: metrics.brier,
    logLoss: metrics.logLoss,
    auc: metrics.auc,
    calibrationError: metrics.calibrationError,
    baseRate: metrics.baseRate,
  };
}

export function fromStoredMetrics(stored: StoredForecastMetrics): ForecastMetrics {
  return {
    count: Number(stored?.count ?? 0),
    brier: Number(stored?.brier ?? 0),
    logLoss: Number(stored?.logLoss ?? 0),
    auc: Number(stored?.auc ?? 0.5),
    calibrationError: Number(stored?.calibrationError ?? 0),
    baseRate: Number(stored?.baseRate ?? 0),
  };
}
