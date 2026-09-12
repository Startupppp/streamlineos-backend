import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../../common/openapi/wire-types";

/**
 * NEO-2/NEO-3 — the quick-commerce wire shapes.
 *
 * Two date conventions sit side by side in these tables and must not be
 * conflated: `expected_delivery_date`, `expiry_date` and `expected_arrival` are
 * `date` columns, which postgres-js returns as `YYYY-MM-DD` strings, while
 * `ordered_at`, `appointment_start` and the timestamps are `Date` objects at
 * the interceptor. Every money figure is integer paise, and every quantity is a
 * `decimal` and therefore an exact string.
 */
const platformPoLineSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  platformPoId: z.number().int(),
  lineOrder: z.number().int(),
  providerSku: z.string().nullable(),
  ean: z.string().nullable(),
  mrpPaise: z.number().int().nullable(),
  packSize: z.number().int().nullable(),
  quantityOrdered: z.string(),
  unitCost: z.string().nullable(),
  productVariantId: z.number().int().nullable(),
  validationError: z.string().nullable(),
});

/** `loadPlatformPo` returns the whole header row plus its ordered lines. */
export const platformPoDetailResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  provider: z.string(),
  providerPoNumber: z.string(),
  channelId: z.number().int().nullable(),
  warehouseId: z.number().int().nullable(),
  status: z.string(),
  destinationRef: z.string().nullable(),
  orderedAt: nullableWireDate(),
  expectedDeliveryDate: z.string().nullable(),
  currency: z.string(),
  poId: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  payloadDigest: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(platformPoLineSchema),
});

/** The list's own projection — narrower than the detail, deliberately. */
export const listPlatformPosResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    provider: z.string(),
    providerPoNumber: z.string(),
    status: z.string(),
    destinationRef: z.string().nullable(),
    expectedDeliveryDate: z.string().nullable(),
    poId: z.number().int().nullable(),
    rejectionReason: z.string().nullable(),
    createdAt: wireDate(),
  }),
);

const asnLineSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  asnId: z.number().int(),
  poLineId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  quantityExpected: z.string(),
  lotNumber: z.string().nullable(),
  expiryDate: z.string().nullable(),
  mrpPaise: z.number().int().nullable(),
  lineOrder: z.number().int(),
});

export const asnDetailResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  asnNumber: z.string(),
  platformPoId: z.number().int().nullable(),
  poId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  locationId: z.number().int().nullable(),
  status: z.string(),
  carrierName: z.string().nullable(),
  trackingRef: z.string().nullable(),
  appointmentStart: nullableWireDate(),
  appointmentEnd: nullableWireDate(),
  expectedArrival: z.string().nullable(),
  notes: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(asnLineSchema),
});

export const listAsnsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    asnNumber: z.string(),
    poId: z.number().int(),
    platformPoId: z.number().int().nullable(),
    warehouseId: z.number().int().nullable(),
    status: z.string(),
    carrierName: z.string().nullable(),
    appointmentStart: nullableWireDate(),
    appointmentEnd: nullableWireDate(),
    expectedArrival: z.string().nullable(),
    createdAt: wireDate(),
  }),
);

/** `FillRateLine` (`lib/fill-rate-report.ts`). */
const fillRateLineSchema = z.object({
  platformPoLineId: z.number().int(),
  productVariantId: z.number().int().nullable(),
  providerSku: z.string().nullable(),
  ean: z.string().nullable(),
  orderedQty: z.string(),
  receivedQty: z.string(),
  shippedQty: z.string(),
  returnedQty: z.string(),
  acceptedQty: z.string(),
  fillRatePct: z.string(),
  payoutQty: z.string(),
  payoutAmountPaise: z.number().int(),
  payoutVariance: z.string().nullable(),
});

/**
 * `FillRateReport`. The unmatched payout lines are part of the answer rather
 * than a footnote: a payout line this report cannot place is the platform
 * paying for something we have no record of shipping.
 */
export const fillRateReportResponseSchema = z.object({
  platformPoId: z.number().int(),
  provider: z.string(),
  providerPoNumber: z.string(),
  status: z.string(),
  warehouseId: z.number().int().nullable(),
  orderedQty: z.string(),
  acceptedQty: z.string(),
  fillRatePct: z.string(),
  lines: z.array(fillRateLineSchema),
  unmatchedPayoutLines: z.array(
    z.object({
      id: z.number().int(),
      payoutRef: z.string(),
      providerPoNumber: z.string().nullable(),
      providerSku: z.string().nullable(),
      ean: z.string().nullable(),
      quantity: z.string(),
      amountPaise: z.number().int(),
      unmatchedReason: z.string().nullable(),
    }),
  ),
});

/**
 * `duplicatesIgnored` is `submitted - stored`: the upload inserts
 * `onConflictDoNothing`, so re-uploading the same file settles nothing twice
 * and the caller is told exactly how much of it was already known.
 */
export const uploadPayoutResponseSchema = z.object({
  payoutRef: z.string(),
  submitted: z.number().int(),
  stored: z.number().int(),
  duplicatesIgnored: z.number().int(),
  unmatched: z.number().int(),
});
