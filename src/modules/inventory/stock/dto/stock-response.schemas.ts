import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

const productRefSchema = z.object({ id: z.number().int(), name: z.string(), sku: z.string() });

const locationRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  code: z.string(),
  warehouse: z.object({ id: z.number().int(), name: z.string() }).optional(),
});

export const stockLevelItemSchema = z.object({
  id: z.number().int(),
  onHand: z.string(),
  committed: z.string(),
  onOrder: z.string(),
  available: z.string(),
  blockedQty: z.string(),
  qualityHoldQty: z.string(),
  // Removed from the payload, not nulled, when the caller cannot see cost.
  averageCost: z.string().nullable().optional(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string().nullable(),
    sku: z.string().nullable(),
    product: z.object({
      id: z.number().int(),
      name: z.string(),
      sku: z.string(),
      reorderPoint: z.string().nullable(),
    }).nullable(),
  }).nullable(),
  location: z.object({
    id: z.number().int(),
    name: z.string(),
    code: z.string(),
    warehouse: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  }).nullable(),
});

export const listStockLevelsResponseSchema = itemsPagedSchema(stockLevelItemSchema);

export const stockTransactionItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  locationId: z.number().int().nullable(),
  transactionType: z.string(),
  quantityChange: z.string(),
  quantityBefore: z.string(),
  quantityAfter: z.string(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  unitCost: z.string().nullable().optional(),
  totalCost: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable(),
  postingDate: z.string().nullable(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  productVariant: z.object({
    id: z.number().int(),
    orgId: z.string(),
    productId: z.number().int(),
    name: z.string(),
    sku: z.string(),
    barcode: z.string().nullable(),
    costPrice: z.string().optional(),
    sellingPrice: z.string(),
    attributeValues: z.record(z.string(), z.string()),
    isActive: z.boolean(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
    product: productRefSchema,
  }).nullable(),
  location: locationRefSchema.nullable(),
  creator: userRefSchema.nullable(),
});

// A cursor walk has no page count to render, so `total` and `totalPages` are
// null on that path; the cursor fields ride alongside on both.
export const listTransactionsResponseSchema = z.object({
  items: z.array(stockTransactionItemSchema),
  total: z.number().int().nullable(),
  page: z.number().int(),
  totalPages: z.number().int().nullable(),
  limit: z.number().int().optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});

export const stockAvailabilityResponseSchema = z.object({
  variantId: z.number().int(),
  onHand: z.string(),
  available: z.string(),
  committed: z.string(),
  incoming: z.string(),
  outgoing: z.string(),
  forecasted: z.string(),
  warehouseBreakdown: z.array(z.object({
    warehouse_id: z.number().int(),
    warehouse_name: z.string(),
    on_hand: z.string(),
    committed: z.string(),
    available: z.string(),
  })),
});

const adjustmentLineSchema = z.object({
  id: z.number().int(),
  adjustmentId: z.number().int(),
  productVariantId: z.number().int(),
  locationId: z.number().int(),
  quantityChange: z.string(),
  uomId: z.number().int().nullable(),
  quantityEntered: z.string().nullable(),
  notes: z.string().nullable(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: productRefSchema,
  }).optional(),
  location: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).optional(),
});

const adjustmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  referenceNumber: z.string(),
  reason: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: wireDate().nullable(),
  postedBy: z.string().nullable(),
  postedByMembershipId: z.number().int().nullable(),
  postedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: userRefSchema.optional(),
  approver: userRefSchema.nullable().optional(),
  poster: userRefSchema.nullable().optional(),
  lines: z.array(adjustmentLineSchema).optional(),
});

export const listAdjustmentsResponseSchema = itemsPagedSchema(adjustmentSchema);

export const getAdjustmentResponseSchema = adjustmentSchema;

const transferLineSchema = z.object({
  id: z.number().int(),
  transferId: z.number().int(),
  productVariantId: z.number().int(),
  quantity: z.string(),
  quantityReceived: z.string(),
  uomId: z.number().int().nullable(),
  quantityEntered: z.string().nullable(),
  dispatchedUnitCost: z.string().nullable().optional(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  notes: z.string().nullable(),
});

const transferSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  referenceNumber: z.string(),
  fromLocationId: z.number().int(),
  toLocationId: z.number().int(),
  fromWarehouseId: z.number().int().nullable(),
  toWarehouseId: z.number().int().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  reservedAt: wireDate().nullable(),
  dispatchedAt: wireDate().nullable(),
  completedAt: wireDate().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  lines: z.array(transferLineSchema).optional(),
  fromLocation: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).optional(),
  toLocation: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).optional(),
  creator: userRefSchema.optional(),
});

export const listTransfersResponseSchema = itemsPagedSchema(transferSchema);

export const getTransferResponseSchema = transferSchema;

export const createTransferResponseSchema = transferSchema;

const reservationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  sourceLineId: z.string().nullable(),
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  locationId: z.number().int().nullable(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  reservedQty: z.string(),
  status: z.string(),
  idempotencyKey: z.string().nullable(),
  expiresAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
  }).optional(),
  location: z.object({ id: z.number().int(), name: z.string(), code: z.string() }).nullable().optional(),
  warehouse: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
});

export const listReservationsResponseSchema = itemsPagedSchema(reservationSchema);

export const createReservationResponseSchema = reservationSchema;

export const stockEngineResultSchema = z.object({
  transactionIds: z.array(z.number().int()),
  levels: z.array(z.object({
    productVariantId: z.number().int(),
    locationId: z.number().int(),
    onHand: z.string(),
  })),
});

/**
 * R3 — the stranded-transit queue and the decision that empties it.
 *
 * The queue rows come back from `db.execute` on hand-written SQL, so they keep
 * the column names the projection asked for and `dispatched_at` arrives as a
 * `Date` — it is not cast to text the way the quantities are.
 */
export const listStrandedTransitResponseSchema = itemsPagedSchema(
  z.object({
    transfer_id: z.number().int(),
    reference_number: z.string().nullable(),
    status: z.string(),
    dispatched_at: wireDate().nullable(),
    transfer_line_id: z.number().int(),
    product_variant_id: z.number().int(),
    sku: z.string().nullable(),
    variant_name: z.string().nullable(),
    lot_id: z.number().int().nullable(),
    lot_number: z.string().nullable(),
    serial_id: z.number().int().nullable(),
    quantity_dispatched: z.string(),
    quantity_received: z.string(),
    quantity_stranded: z.string(),
    transit_location_id: z.number().int(),
    transit_location_code: z.string().nullable(),
    transit_warehouse_id: z.number().int(),
    transit_on_hand: z.string(),
    from_location_id: z.number().int(),
    to_location_id: z.number().int().nullable(),
  }),
);

/** `TransitExitResult` — and the shape `reviveTransitExit` rebuilds on a replay. */
export const transitExitResponseSchema = z.object({
  transferId: z.number().int(),
  disposition: z.string(),
  /** Where the goods were standing, so a caller can look at what is left. */
  transitLocationId: z.number().int(),
  lines: z.array(
    z.object({ transferLineId: z.number().int(), quantity: z.string() }),
  ),
  transactionIds: z.array(z.number().int()),
  /** Terminal once nothing is left in transit. */
  transferStatus: z.string(),
  strandedRemaining: z.string(),
});
