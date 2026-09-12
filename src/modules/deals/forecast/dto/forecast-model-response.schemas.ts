import { z } from "zod";

/**
 * The three questions a tenant can ask about their own forecast model.
 *
 * Two of the shapes are discriminated unions and are declared as such rather
 * than flattened: `ForecastBasis` and `TrainingAttempt` exist precisely so that
 * a surface cannot render a learned model's confidence beside a naive one's
 * arithmetic by forgetting a check, and a contract that merged the arms would
 * throw that away.
 */

const forecastMetricsSchema = z.object({
  count: z.number().int(),
  brier: z.number(),
  logLoss: z.number(),
  auc: z.number(),
  calibrationError: z.number(),
  baseRate: z.number(),
});

/** `assessForecastHistory` — what is missing, not merely that something is. */
const forecastReadinessSchema = z.object({
  ready: z.boolean(),
  closedDeals: z.number().int(),
  wonDeals: z.number().int(),
  lostDeals: z.number().int(),
  minimumClosedDeals: z.number().int(),
  minimumPerOutcome: z.number().int(),
  closedDealsNeeded: z.number().int(),
  wonDealsNeeded: z.number().int(),
  lostDealsNeeded: z.number().int(),
});

/** `ForecastBasis` — what the number on screen actually is. */
export const forecastBasisResponseSchema = z.union([
  z.object({
    kind: z.literal("learned"),
    modelId: z.string(),
    /** Already an ISO string here: `basisFor` serialises both instants itself. */
    trainedAt: z.string(),
    featureSpecVersion: z.string(),
    trainingDeals: z.number().int(),
    holdoutDeals: z.number().int(),
    holdout: forecastMetricsSchema,
    naiveHoldout: forecastMetricsSchema,
    becameAvailableAt: z.string(),
  }),
  z.object({
    kind: z.literal("naive-weighted"),
    reason: z.string(),
    readiness: forecastReadinessSchema,
  }),
]);

/**
 * `TrainingAttempt` — a run that refused to store its model is still a 200.
 *
 * `learned` and `naive` are present on the rejected arm whenever a fit actually
 * ran, so the refusal can be argued with rather than merely reported.
 */
export const trainForecastResponseSchema = z.union([
  z.object({
    trained: z.literal(true),
    modelId: z.string(),
    readiness: forecastReadinessSchema,
    trainingDeals: z.number().int(),
    holdoutDeals: z.number().int(),
    learned: forecastMetricsSchema,
    naive: forecastMetricsSchema,
    scored: z.number().int(),
  }),
  z.object({
    trained: z.literal(false),
    reason: z.string(),
    readiness: forecastReadinessSchema,
    learned: forecastMetricsSchema.nullable(),
    naive: forecastMetricsSchema.nullable(),
  }),
]);

/**
 * `getDealScore` — wrapped, because "no score" is a normal answer.
 *
 * Null when the organisation has no learned model, or when this deal has not
 * been scored under the current one.
 */
export const dealForecastScoreResponseSchema = z.object({
  score: z
    .object({
      dealId: z.number().int(),
      probability: z.number(),
      intervalLower: z.number(),
      intervalUpper: z.number(),
      expectedValueMinor: z.number(),
      asOf: z.string(),
      scoredAt: z.string(),
      factors: z.array(
        z.object({
          feature: z.string(),
          value: z.number(),
          contribution: z.number(),
          direction: z.enum(["increases", "decreases"]),
        }),
      ),
    })
    .nullable(),
});
