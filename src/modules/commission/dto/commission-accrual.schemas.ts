import { z } from "zod";

/**
 * The contract for reading an accrual and for rebuilding one.
 *
 * Every route here is a read of somebody's compensation, so the shape of these
 * queries is a security surface and not only a validation one: `userId` is
 * accepted but never trusted — `accrualViewerFilter` in the service decides
 * whose rows the caller actually gets, from the RBAC scope the guard resolved.
 * The field exists so a manager at scope `all` can name a rep, not so a rep can
 * name a colleague.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD");

/**
 * Which period, named by any date inside it.
 *
 * A date rather than a period label because the period length is a property of
 * the plan version in force — MONTH, QUARTER or YEAR — and the caller does not
 * know it. Asking for "the period containing the 14th" is answerable whatever
 * the plan says; asking for "2026-03" is not, and would silently mean different
 * spans for two reps on different plans.
 */
export const accrualQuerySchema = z
  .object({
    userId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
    on: isoDate.optional(),
  })
  .strict();

export const accrualCurveQuerySchema = z
  .object({
    userId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Hard cap. A year of daily points is 366; 800 covers any real span. */
    limit: z.coerce.number().int().min(1).max(800).default(400),
  })
  .strict();

/** A deal id. `deals.id` is `serial`, so an integer, but stored as text. */
export const accrualByDealQuerySchema = z
  .object({
    dealId: z.coerce.number().int().positive(),
  })
  .strict();

/**
 * Rebuild the decomposition for a bounded set of earnings.
 *
 * Bounded deliberately: there is no "rebuild everything". Every rebuild deletes
 * and rewrites the parts of the earnings it touches, and an unbounded one would
 * hold a transaction across a tenant's entire commission history. `from` and
 * `to` are required for that reason rather than defaulted to all time.
 *
 * A rebuild never changes an earning's `amount_minor`. It re-derives the parts
 * from the computation already stored on the row, so it can repair a
 * decomposition — including supplying one for an earning written before this
 * ticket existed — without being able to restate a payout.
 */
export const rebuildAccrualSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    userId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
    /** Hard cap on earnings touched in one transaction. */
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.to < value.from)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "the end of the range cannot precede its start",
      });
  });

export type AccrualQuery = z.infer<typeof accrualQuerySchema>;
export type AccrualCurveQuery = z.infer<typeof accrualCurveQuerySchema>;
export type AccrualByDealQuery = z.infer<typeof accrualByDealQuerySchema>;
export type RebuildAccrualInput = z.infer<typeof rebuildAccrualSchema>;
