import { z } from "zod";
import { wireDate } from "../../../../../common/openapi/wire-types";

/**
 * F6 — what filing a verdict returns.
 *
 * The insert's `returning({...})` projection and nothing else: the row also
 * carries the model, the token count and the cost, and none of that is the
 * reporter's to read back.
 */
export const submitAiFeedbackResponseSchema = z.object({
  id: z.number().int(),
  verdict: z.string(),
  surface: z.string(),
  createdAt: wireDate(),
});

/**
 * `usefulRatio` is null until somebody rates the surface, and deliberately
 * excludes `UNSAFE` — see the service. `unsafeTotal` is reported separately for
 * the same reason.
 */
const aiFeedbackSurfaceSchema = z.object({
  surface: z.string(),
  useful: z.number().int(),
  wrong: z.number().int(),
  stale: z.number().int(),
  unsafe: z.number().int(),
  total: z.number().int(),
  usefulRatio: z.number().nullable(),
});

export const aiFeedbackSummaryResponseSchema = z.object({
  days: z.number().int(),
  surfaces: z.array(aiFeedbackSurfaceSchema),
  unsafeTotal: z.number().int(),
});
