import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const listStockLevelsSchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  variantId: z.coerce.number().int().positive().optional(),
  lotId: z.coerce.number().int().positive().optional(),
  serialId: z.coerce.number().int().positive().optional(),
  lowStock: queryBoolean.optional(),
  negative: queryBoolean.optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListStockLevelsInput = z.infer<typeof listStockLevelsSchema>;

export const listTransactionsSchema = z.object({
  productVariantId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  transactionType: z.enum([
    "PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT",
    "RETURN_IN", "RETURN_OUT", "GRN", "OPENING_BALANCE", "VENDOR_RETURN", "CUSTOMER_RETURN",
    "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS", "SCRAP", "QUARANTINE_IN", "QUARANTINE_OUT",
    "RESERVATION_CREATE", "RESERVATION_RELEASE", "RESERVATION_CONSUME",
  ]).optional(),
  direction: z.enum(["in", "out"]).optional(),
  search: z.string().max(200).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;

export const availabilityQuerySchema = z.object({
  variantId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive().optional(),
}).strict();
export type AvailabilityQueryInput = z.infer<typeof availabilityQuerySchema>;

export const listReservationsSchema = z.object({
  sourceType: z.string().max(100).optional(),
  status: z.enum(["ACTIVE", "CONSUMED", "RELEASED", "EXPIRED"]).optional(),
  variantId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListReservationsInput = z.infer<typeof listReservationsSchema>;

export const createReservationSchema = z.object({
  sourceType: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(100),
  sourceLineId: z.string().max(100).optional(),
  productVariantId: z.number().int().positive(),
  warehouseId: z.number().int().positive().optional(),
  locationId: z.number().int().positive(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
  qty: z.string().regex(/^\d+(\.\d+)?$/, "must be a positive decimal"),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const releaseReservationSchema = z.object({
  reservationId: z.number().int().positive(),
}).strict();
export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

const openingStockLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  qty: z.number().positive(),
  unitCost: z.number().min(0).optional(),
}).strict();

export const openingStockSchema = z.object({
  lines: z.array(openingStockLineSchema).min(1).max(500),
  notes: z.string().max(500).optional(),
}).strict();
export type OpeningStockInput = z.infer<typeof openingStockSchema>;

export const adjustmentReasons = [
  "PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER", "SCRAP",
] as const;

export const listAdjustmentsSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "PENDING_POST", "POSTED", "CANCELLED"]).optional(),
  reason: z.enum(adjustmentReasons).optional(),
  /** D8. Every reason that condemns stock, in one filter — the write-off queue. */
  writeOffsOnly: queryBoolean.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListAdjustmentsInput = z.infer<typeof listAdjustmentsSchema>;

const adjustmentLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  quantityChange: z.number().refine((v) => v !== 0, { message: "must not be zero" }),
  notes: z.string().max(500).optional(),
}).strict();

export const createAdjustmentSchema = z.object({
  reason: z.enum(adjustmentReasons),
  notes: z.string().max(1000).optional(),
  /**
   * D8. Where the condemned goods physically went, for a write-off reason only.
   * Optional: the server resolves the warehouse's own scrap bin when the caller
   * names none, and a warehouse that has no scrap bin still writes stock off.
   */
  scrapLocationId: z.number().int().positive().optional(),
  lines: z.array(adjustmentLineSchema).min(1),
}).strict();
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const listTransfersSchema = z.object({
  status: z.enum(["PENDING", "RESERVED", "IN_TRANSIT", "COMPLETED", "CANCELLED"]).optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  fromWarehouseId: z.coerce.number().int().positive().optional(),
  toWarehouseId: z.coerce.number().int().positive().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListTransfersInput = z.infer<typeof listTransfersSchema>;

const transferLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
}).strict();

export const createTransferSchema = z.object({
  fromLocationId: z.number().int().positive(),
  toLocationId: z.number().int().positive(),
  fromWarehouseId: z.number().int().positive().optional(),
  toWarehouseId: z.number().int().positive().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(transferLineSchema).min(1),
}).strict();
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const completeTransferSchema = z.object({
  lines: z.array(z.object({
    transferLineId: z.number().int().positive(),
    quantityReceived: z.number().min(0),
  }).strict()).min(1),
}).strict();
export type CompleteTransferInput = z.infer<typeof completeTransferSchema>;
