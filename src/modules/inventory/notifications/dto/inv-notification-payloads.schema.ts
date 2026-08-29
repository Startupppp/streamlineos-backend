import { z } from "zod";

/**
 * G3 — the three triggers inventory owed beyond low stock.
 *
 * Each is validated on the way *out* of the outbox rather than trusted, for the
 * reason `invStockLowPayloadSchema` is: a consumer reads a row written by an
 * older deploy, and a payload that has since changed shape must be skipped with
 * a reason rather than crash the relay for every event behind it.
 */

export const invLotExpiringPayloadSchema = z
  .object({
    lotId: z.number().int().positive(),
    lotNumber: z.string().min(1),
    productVariantId: z.number().int().positive(),
    /** ISO date. The lot's own expiry, not the day the sweep noticed it. */
    expiryDate: z.string().min(1),
    /** Which configured window this crossing belongs to — 90, 60 or 30. */
    windowDays: z.number().int().positive(),
    /** On-hand across every location, as a decimal string. Never a float. */
    onHand: z.string().min(1),
  })
  .strict();

export type InvLotExpiringPayload = z.infer<typeof invLotExpiringPayloadSchema>;

export const invAdjustmentApprovalPayloadSchema = z
  .object({
    adjustmentId: z.number().int().positive(),
    referenceNumber: z.string().min(1),
    reason: z.string().min(1),
    lineCount: z.number().int().nonnegative(),
    /** Who raised it, so the dispatcher can avoid notifying them about their own request. */
    requestedByUserId: z.string().min(1),
  })
  .strict();

export type InvAdjustmentApprovalPayload = z.infer<
  typeof invAdjustmentApprovalPayloadSchema
>;

export const invRecallOpenedPayloadSchema = z
  .object({
    recallId: z.number().int().positive(),
    referenceNumber: z.string().min(1),
    title: z.string().min(1),
    lotCount: z.number().int().nonnegative(),
    quarantinedGrains: z.number().int().nonnegative(),
    openedByUserId: z.string().min(1),
  })
  .strict();

export type InvRecallOpenedPayload = z.infer<typeof invRecallOpenedPayloadSchema>;
