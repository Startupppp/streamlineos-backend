import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

const recentMovementSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productVariantId: z.number().int(),
  locationId: z.number().int().nullable(),
  transactionType: z.string(),
  quantityChange: z.string(),
  quantityBefore: z.string(),
  quantityAfter: z.string(),
  unitCost: z.string().nullable().optional(),
  totalCost: z.string().nullable().optional(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  productVariant: z.object({
    id: z.number().int(),
    name: z.string(),
    sku: z.string(),
    product: z.object({ id: z.number().int(), name: z.string(), sku: z.string() }),
  }).optional(),
  location: z.object({ id: z.number().int(), name: z.string() }).optional(),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
});

const insightSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  insightType: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  sourceRefs: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  createdAt: wireDate(),
});

export const dashboardResponseSchema = z.object({
  stockSummary: z.object({
    totalSkus: z.number().int(),
    totalOnHand: z.number(),
    totalCommitted: z.number(),
    totalOnOrder: z.number(),
  }).optional(),
  lowStockCount: z.number().int(),
  draftPoCount: z.number().int(),
  openSoCount: z.number().int(),
  recentMovements: z.array(recentMovementSchema),
  stockValue: z.number(),
  expiringLotsCount: z.number().int(),
  qualityHoldQty: z.number(),
  activeReservationsCount: z.number().int(),
  openShipmentsCount: z.number().int(),
  failedChannelSyncsCount: z.number().int(),
  openInspectionsCount: z.number().int(),
  recentInsights: z.array(insightSchema),
});

const stockSummaryItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  categoryId: z.number().int().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  onHand: z.string(),
  committed: z.string(),
  available: z.string(),
  onOrder: z.string(),
  averageCost: z.string().nullable().optional(),
  totalValue: z.number().optional(),
  reorderPoint: z.string().optional(),
  isLowStock: z.boolean().optional(),
});

export const stockSummaryResponseSchema = itemsPagedSchema(stockSummaryItemSchema);

const movementItemSchema = z.object({
  id: z.number().int(),
  transactionType: z.string(),
  quantityChange: z.string(),
  createdAt: wireDate(),
  productVariantId: z.number().int(),
  variantSku: z.string().optional(),
  variantName: z.string().optional(),
});

export const movementsReportResponseSchema = itemsPagedSchema(movementItemSchema);

const valuationReportItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  onHand: z.number(),
  value: z.number(),
  costingMethod: z.string().optional(),
});

export const valuationReportResponseSchema = itemsPagedSchema(valuationReportItemSchema);

const slowMovingItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  onHand: z.string().optional(),
  lastMovementDate: z.string().nullable().optional(),
  daysSinceLastMovement: z.number().int().optional(),
});

export const slowMovingReportResponseSchema = itemsPagedSchema(slowMovingItemSchema);

const expiryReportItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  lotId: z.number().int().optional(),
  lotNumber: z.string().optional(),
  expiryDate: z.string().nullable(),
  daysUntilExpiry: z.number().int(),
  totalOnHand: z.string(),
});

export const expiryReportResponseSchema = itemsPagedSchema(expiryReportItemSchema);

const reorderItemSchema = z.object({
  productVariantId: z.number().int(),
  variantSku: z.string(),
  variantName: z.string(),
  productId: z.number().int(),
  productName: z.string(),
  onHand: z.string().optional(),
  reorderPoint: z.string().optional(),
  suggestedQty: z.number().optional(),
  vendorId: z.number().int().nullable().optional(),
  vendorName: z.string().nullable().optional(),
});

export const reorderReportResponseSchema = itemsPagedSchema(reorderItemSchema);

/**
 * INV-210 — what the warehouse did over a window.
 *
 * Rates travel beside their numerator and denominator rather than alone: "50%"
 * means something different over four lines than over four hundred, and a
 * contract that carried only the percentage would let the counts drift out.
 */
export const throughputResponseSchema = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  receiving: z.object({
    receipts: z.number().int(),
    lines: z.number().int(),
    discrepancyLines: z.number().int(),
    discrepancyRate: z.number(),
  }),
  picking: z.object({
    linesTotal: z.number().int(),
    linesConfirmed: z.number().int(),
    exceptionLines: z.number().int(),
    exceptionRate: z.number(),
    wavesCompleted: z.number().int(),
  }),
  shipping: z.object({
    shipped: z.number().int(),
    delivered: z.number().int(),
    /** Median hours from dispatch to the carrier's delivered scan. */
    medianTransitHours: z.number().nullable(),
  }),
});

const ageBandSchema = z.object({
  label: z.enum(["0-4h", "4-24h", "24-72h", "72h+"]),
  count: z.number().int(),
  /** The oldest item in this band, in hours. Null exactly when `count` is 0. */
  oldestHours: z.number().nullable(),
});

const agingStageSchema = z.object({
  open: z.number().int(),
  bands: z.array(ageBandSchema),
});

/**
 * How long the open work in each stage has been standing there.
 *
 * `scopedWarehouseIds` is never omitted and `[]` is a real value: a caller
 * assigned no warehouse has to be distinguishable from a quiet floor, which is
 * the one thing the throughput report cannot say.
 */
export const workAgingResponseSchema = z.object({
  asOf: z.string(),
  scopedWarehouseIds: z.array(z.number().int()).nullable(),
  receipts: agingStageSchema,
  putaway: agingStageSchema,
  picking: agingStageSchema,
  pickExceptions: agingStageSchema,
  shipping: agingStageSchema,
});
