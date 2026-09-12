import { z } from "zod";

/**
 * The two reconciliation reports, transcribed from `UnpostedMovementsReport`
 * and `StockGlReconciliation`.
 *
 * Both answer with `enabled: false` and zeros for an org that never enabled
 * accounting, so every numeric field is present in that case too — the schema
 * is one shape, not a union.
 */

const unpostedReasonSchema = z.enum(["no_posting_path", "post_missing", "not_applicable"]);

const reasonTotalsSchema = z.object({
  transactionType: z.string(),
  reason: unpostedReasonSchema,
  movements: z.number().int(),
  valueMinor: z.number().int(),
});

export const unpostedMovementsResponseSchema = z.object({
  enabled: z.boolean(),
  from: z.string(),
  to: z.string(),
  movements: z.number().int(),
  valueMinor: z.number().int(),
  byReason: z.array(
    z.object({
      reason: unpostedReasonSchema,
      movements: z.number().int(),
      valueMinor: z.number().int(),
    }),
  ),
  byTransactionType: z.array(reasonTotalsSchema),
  sample: z.array(
    z.object({
      transactionId: z.number().int(),
      postingDate: z.string().nullable(),
      transactionType: z.string(),
      referenceType: z.string().nullable(),
      referenceId: z.string().nullable(),
      valueMinor: z.number().int(),
      reason: unpostedReasonSchema,
    }),
  ),
  notes: z.array(z.string()),
});

export const stockGlReconciliationResponseSchema = z.object({
  enabled: z.boolean(),
  from: z.string(),
  to: z.string(),
  glMovementMinor: z.number().int(),
  postedMovementValueMinor: z.number().int(),
  unpostedValueMinor: z.number().int(),
  bridgeDifferenceMinor: z.number().int(),
  verdict: z.enum(["balanced", "explained_by_unposted", "unexplained"]),
  /** A slice of the unposted report's own per-type totals, so the shape matches. */
  exceptions: z.array(reasonTotalsSchema),
  notes: z.array(z.string()),
});
