import { z } from "zod";

/**
 * The customer health surface's boundary.
 *
 * There is no body on any of these routes and that is deliberate: a health score
 * is computed from what the system already holds, so a caller cannot hand it an
 * input. The moment a route accepts a value to score with, the number stops
 * being reproducible from the sources and the decomposition stops being an
 * explanation of anything.
 *
 * Bounds reject rather than clamp, following `lifecycle.schemas.ts`: a caller
 * who asked for a thousand rows and silently got fifty concludes the tenant has
 * fifty customers.
 */

export const HEALTH_BANDS = ["healthy", "at_risk", "critical"] as const;

export const customerHealthRosterQuerySchema = z
  .object({
    /** The band, in `crm_health`'s vocabulary — the enum the column holds. */
    band: z.enum(HEALTH_BANDS).optional(),
    /**
     * Only the customers the model could not score.
     *
     * A filter rather than a footnote, because this is the list the feature is
     * for: an unscored customer is one nobody has enough information about, and
     * they are invisible on every band-filtered screen precisely because they
     * have no band. Mutually exclusive with `band` — a refinement below refuses
     * the pair rather than silently letting one win.
     */
    unscored: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .refine((query) => !(query.unscored === true && query.band !== undefined), {
    message: "band and unscored cannot be combined: an unscored customer has no band",
    path: ["band"],
  });

export type CustomerHealthRosterQuery = z.infer<typeof customerHealthRosterQuerySchema>;
