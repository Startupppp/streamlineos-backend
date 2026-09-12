import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const lotListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string().optional(),
  productVariantId: z.number().int(),
  lotNumber: z.string(),
  manufactureDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  supplierLotNumber: z.string().nullable(),
  status: z.string(),
  qualityStatus: z.string().nullable(),
  createdAt: wireDate(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  productSku: z.string(),
  totalOnHand: z.string(),
});

export const listLotsResponseSchema = itemsPagedSchema(lotListItemSchema);

const serialListItemSchema = z.object({
  id: z.number().int(),
  serialNumber: z.string(),
  lotId: z.number().int().nullable(),
  status: z.string(),
  currentLocationId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  createdAt: wireDate(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  currentLocationName: z.string().nullable(),
  currentLocationCode: z.string().nullable(),
});

export const listSerialsResponseSchema = itemsPagedSchema(serialListItemSchema);

export const updateLotStatusResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  lotNumber: z.string(),
  manufactureDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  supplierLotNumber: z.string().nullable(),
  status: z.string(),
  qualityStatus: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const getLotDetailResponseSchema = z.object({
  lot: z.record(z.string(), z.unknown()),
  stockByLocation: z.array(z.object({
    locationId: z.number().int(),
    locationName: z.string(),
    locationCode: z.string(),
    warehouseId: z.number().int(),
    warehouseName: z.string(),
    onHand: z.string(),
    committed: z.string(),
    blockedQty: z.string().nullable(),
  })),
  movements: z.array(z.record(z.string(), z.unknown())),
});

export const getSerialDetailResponseSchema = z.object({
  serial: z.record(z.string(), z.unknown()),
  movements: z.array(z.record(z.string(), z.unknown())),
});

export const expiryReportResponseSchema = z.array(z.object({
  id: z.number().int(),
  lotNumber: z.string(),
  expiryDate: z.string().nullable(),
  status: z.string(),
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  totalOnHand: z.string(),
  daysUntilExpiry: z.number().int(),
}));

export const traceabilityChainResponseSchema = z.object({
  origin: z.record(z.string(), z.unknown()).nullable(),
  receipts: z.array(z.record(z.string(), z.unknown())),
  currentStock: z.array(z.record(z.string(), z.unknown())),
  shipments: z.array(z.record(z.string(), z.unknown())),
  vendorReturns: z.array(z.record(z.string(), z.unknown())),
  customerReturns: z.array(z.record(z.string(), z.unknown())),
  events: z.array(z.record(z.string(), z.unknown())),
});

/**
 * D1 — the bounded genealogy graph.
 *
 * A truncated answer has to look truncated: `complete: false` plus at least one
 * reason is the only honest way to serve a partial recall trace, and both are
 * declared here so a client cannot read a capped graph as a whole one.
 */
const genealogyNodeSchema = z.object({
  /** `lot:12` · `serial:7` · `inv_grn:41`. Stable within one answer. */
  key: z.string(),
  kind: z.string(),
  label: z.string(),
  /** Hops from the anchor, which is 0. */
  depth: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  fanoutTruncated: z.boolean(),
  unexplored: z.boolean(),
});

const genealogyEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["MOVEMENT", "CONTAINS"]),
  direction: z.string(),
  transactionId: z.number().int().nullable(),
  transactionType: z.string().nullable(),
  /** Decimal(18,4) as text. Never a float. */
  quantity: z.string().nullable(),
  locationId: z.number().int().nullable(),
  occurredAt: z.string().nullable(),
  reversed: z.boolean(),
  closesCycle: z.boolean(),
});

export const genealogyGraphResponseSchema = z.object({
  anchor: z.object({
    kind: z.enum(["lot", "serial"]),
    id: z.number().int(),
    key: z.string(),
    label: z.string(),
    productVariantId: z.number().int(),
    productName: z.string().nullable(),
    sku: z.string().nullable(),
  }),
  caps: z.object({
    direction: z.string(),
    maxDepth: z.number().int(),
    maxNodes: z.number().int(),
    maxFanout: z.number().int(),
  }),
  nodes: z.array(genealogyNodeSchema),
  edges: z.array(genealogyEdgeSchema),
  truncation: z.object({
    complete: z.boolean(),
    reasons: z.array(z.string()),
    depthReached: z.number().int(),
    nodeCount: z.number().int(),
    edgeCount: z.number().int(),
    unexploredNodes: z.number().int(),
    fanoutTruncatedNodes: z.array(z.string()),
  }),
  corrections: z.object({ excludedFromWalk: z.boolean() }),
  /** The caller sees a subset of warehouses, so the graph is partial. */
  warehouseScoped: z.boolean(),
});

/**
 * D2 — every allocation taken past the allocator's refusal.
 *
 * Keyset-paged, and the pagination fields sit beside `items` rather than under a
 * `pagination` key: this surface spreads the page's own fields, so
 * `cursorPageSchema` would describe a different envelope from the one it sends.
 * The policy columns are snapshots, so a row still explains itself after the
 * settings behind it are edited.
 */
export const listAllocationOverridesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      actorUserId: z.string(),
      /** Left-joined and name-only: the users relation is never unprojected. */
      actorName: z.string().nullable(),
      reason: z.string(),
      verdict: z.string(),
      lotId: z.number().int().nullable(),
      lotNumber: z.string(),
      lotExpiryDate: z.string(),
      daysRemaining: z.number().int(),
      nearExpiryPolicy: z.string(),
      nearExpiryWindowDays: z.number().int(),
      minShelfLifeDays: z.number().int(),
      productVariantId: z.number().int(),
      sourceType: z.string(),
      sourceId: z.string(),
      clientId: z.number().int().nullable(),
      clientName: z.string().nullable(),
      reservationId: z.number().int().nullable(),
      createdAt: wireDate(),
    }),
  ),
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
