import { z } from "zod";

/** A calendar day, not an instant. Both reports below measure in whole days. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** INV-210. A bounded window: an unbounded scan of every movement ever is not a dashboard. */
export const throughputQuerySchema = z
  .object({
    from: isoDay,
    to: isoDay,
    /**
     * One site rather than the union of the caller's.
     *
     * A supervisor of three buildings could previously only see all three added
     * together, which is the one view that answers no operational question: a
     * backlog at one site and a quiet day at the other two average into an
     * unremarkable number. Optional, so the union stays the default.
     *
     * Out of the caller's scope answers 404, never 403 — a 403 on an id the
     * caller may not see confirms it exists.
     */
    warehouseId: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: "from must not be after to" });
export type ThroughputQueryInput = z.infer<typeof throughputQuerySchema>;

/**
 * How long the work standing in each stage has been standing there.
 *
 * No window, because aging is not a window: the question is what is open *now*
 * and how long it has been open, and a `from` would silently hide the oldest
 * item on the floor — the one the report exists to surface.
 *
 * `asOf` is the day the report is taken as of, defaulting to today. It moves the
 * reference instant the ages are measured back from; it does not reconstruct
 * history, because nothing here records when a status changed.
 */
export const workAgingQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    asOf: isoDay.optional(),
  })
  .strict();
export type WorkAgingQueryInput = z.infer<typeof workAgingQuerySchema>;
