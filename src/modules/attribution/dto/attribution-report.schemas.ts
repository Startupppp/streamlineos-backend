import { z } from "zod";
import {
  ATTRIBUTION_MODELS,
  DEFAULT_HALF_LIFE_DAYS,
  MAX_HALF_LIFE_DAYS,
  isAttributionModel,
  type AttributionModel,
} from "../attribution-models";

/**
 * Linear, because the point of this endpoint is that last-click is a choice.
 *
 * The shipped report offers first-touch and last-touch and nothing else, so the
 * default there is the last-click model the PRD wants replaced. Linear is the
 * multi-touch model with no parameter to get wrong: it makes no claim about
 * which touch mattered most, which is the honest starting position before a
 * tenant has told us how fast their attention decays.
 */
export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = "linear";

/**
 * Validated by `isAttributionModel` rather than a second list of names.
 *
 * `ATTRIBUTION_MODELS` is the catalog; restating it as a `z.enum` here would be
 * a copy that type-checks while disagreeing, and the disagreement would surface
 * as a 400 on a model the engine implements. The names are still interpolated
 * into the message so a caller who gets it wrong is told what is on offer.
 */
export const attributionReportQuerySchema = z
  .object({
    model: z
      .string()
      .refine(isAttributionModel, {
        message: `model must be one of: ${ATTRIBUTION_MODELS.join(", ")}`,
      })
      .default(DEFAULT_ATTRIBUTION_MODEL),
    /**
     * Only `time_decay` reads it, and it is capped rather than free.
     * `MAX_HALF_LIFE_DAYS` is ten years: past it the curve is flat and the model
     * is linear with extra steps, so a caller asking for it has misunderstood
     * and should be told so rather than served.
     */
    halfLifeDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_HALF_LIFE_DAYS)
      .default(DEFAULT_HALF_LIFE_DAYS),
  })
  .strict();

export type AttributionReportQuery = z.infer<typeof attributionReportQuerySchema>;
