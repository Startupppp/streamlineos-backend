import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * Customer health, as the two reads and the recompute return it.
 *
 * `score` and `band` are null together and deliberately: too little of the model
 * spoke, and a stand-in value would be a number somebody plans around. `unscored`
 * is present exactly then, and says which inputs were unavailable.
 */

const healthFactorKeySchema = z.enum(["usage", "engagement", "support", "sentiment"]);

/** Raw counts behind a factor's value — the layer below the decomposition. */
const factorDetailSchema = z.record(z.string(), z.number().nullable());

/** One row of `customer_health_factors`, as `get` projects it. */
const storedHealthFactorSchema = z.object({
  factorKey: healthFactorKeySchema,
  weightBps: z.number().int(),
  effectiveWeightBps: z.number().int(),
  status: z.string(),
  /** Null exactly when the input is missing. */
  value: z.number().int().nullable(),
  /** Null exactly when the input is measured. */
  missingReason: z.string().nullable(),
  contributionBps: z.number().int(),
  observations: z.number().int(),
  windowDays: z.number().int(),
  windowFrom: wireDate(),
  windowTo: wireDate(),
  detail: factorDetailSchema,
});

/** `DecomposedHealthFactor`, which a freshly computed assessment returns instead. */
const computedHealthFactorSchema = z.object({
  key: healthFactorKeySchema,
  weightBps: z.number().int(),
  window: z.object({
    days: z.number().int(),
    from: wireDate(),
    to: wireDate(),
  }),
  status: z.enum(["measured", "missing"]),
  detail: factorDetailSchema,
  effectiveWeightBps: z.number().int(),
  contributionBps: z.number().int(),
});

const assessmentHeadSchema = z.object({
  customerHealthAssessmentId: z.string(),
  partyId: z.string(),
  /** Null when the party record has gone; the assessment stays on the roster. */
  partyName: z.string().nullable(),
  score: z.number().int().nullable(),
  healthStatus: z.string().nullable(),
  coverageBps: z.number().int(),
  weightsVersion: z.number().int(),
  computedAt: wireDate(),
});

/** `roster` — worst first, unscored last. */
export const customerHealthRosterResponseSchema = z.object({
  data: z.array(assessmentHeadSchema),
});

/** `get` — the stored assessment with the factor rows that produced it. */
export const customerHealthResponseSchema = z.object({
  data: assessmentHeadSchema.extend({
    factors: z.array(storedHealthFactorSchema),
  }),
});

/**
 * `recompute` — the assessment just written, straight off the composite.
 *
 * Its factors are the in-process `DecomposedHealthFactor` shape rather than the
 * stored rows, so the two reads differ here on purpose and the contract says so.
 */
export const recomputeCustomerHealthResponseSchema = z.object({
  data: z.object({
    partyId: z.string(),
    partyName: z.string().nullable(),
    customerHealthAssessmentId: z.string(),
    computedAt: wireDate(),
    score: z.number().int().nullable(),
    band: z.enum(["healthy", "at_risk", "critical"]).nullable(),
    coverageBps: z.number().int(),
    weightsVersion: z.number().int(),
    weightsBps: z.record(z.string(), z.number().int()),
    factors: z.array(computedHealthFactorSchema),
    unscored: z
      .object({
        reason: z.literal("insufficient-coverage"),
        missing: z.array(
          z.object({
            key: healthFactorKeySchema,
            weightBps: z.number().int(),
            reason: z.string(),
          }),
        ),
      })
      .nullable(),
  }),
});
