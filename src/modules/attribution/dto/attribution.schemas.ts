import { z } from "zod";
import { ATTRIBUTION_MODELS } from "../attribution-models";

/**
 * A model is always named, never defaulted silently.
 *
 * `.default("last-touch")` would have been convenient and is exactly the bug
 * ticket 18 exists to remove: a caller who says nothing gets last-touch, the
 * figure comes back captioned last-touch, and nobody notices that the default is
 * doing the deciding. The parameter is required, so choosing a model is
 * something the caller did.
 */
const modelParameter = z.enum(ATTRIBUTION_MODELS);

export const attributionForDealQuerySchema = z
  .object({ model: modelParameter })
  .strict();

export const attributionReportQuerySchema = z
  .object({
    model: modelParameter,
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) => new Date(value.from).getTime() <= new Date(value.to).getTime(),
    "The window ends before it starts",
  );

export type AttributionForDealQuery = z.infer<typeof attributionForDealQuerySchema>;
export type AttributionReportQueryInput = z.infer<typeof attributionReportQuerySchema>;
