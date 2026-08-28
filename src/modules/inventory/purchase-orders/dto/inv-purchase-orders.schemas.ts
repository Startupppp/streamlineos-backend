import { z } from "zod";

export const listPoSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]).optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListPoInput = z.infer<typeof listPoSchema>;

const poLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  /** In `uomId` when one is given, otherwise in the product's base unit. */
  quantity: z.number().positive(),
  /**
   * The unit the buyer typed in. The server resolves the factor and computes the
   * base quantity — a client-supplied factor would let the caller decide how
   * many units a case holds.
   */
  uomId: z.number().int().positive().optional(),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  lineOrder: z.number().int().min(0).default(0),
}).strict();

export const createPoSchema = z.object({
  vendorId: z.number().int().positive(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).default("INR"),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1),
}).strict();
export type CreatePoInput = z.infer<typeof createPoSchema>;

export const updatePoSchema = z.object({
  vendorId: z.number().int().positive().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1).optional(),
}).strict();
export type UpdatePoInput = z.infer<typeof updatePoSchema>;

const grnLotLineSchema = z.object({
  poLineId: z.number().int().positive(),
  /**
   * INV-201. A decimal string, not a number. This quantity becomes a stock
   * ledger row, and it was reaching the engine as `Number(...).toFixed(4)` --
   * float arithmetic on the one value the inventory PRD forbids it for.
   */
  quantityReceived: z.string().regex(/^\d+(\.\d{1,4})?$/),
  /**
   * Why the line did not match what the purchase order still owed. Optional:
   * a routine partial delivery is not an exception and should not demand
   * paperwork, and the expected quantity is snapshotted either way.
   */
  discrepancyReason: z.enum(["SHORT", "OVER", "DAMAGED", "WRONG_ITEM"]).optional(),
  qualityStatus: z.enum(["ACCEPTED", "REJECTED"]).default("ACCEPTED"),
  rejectionReason: z.string().max(500).optional(),
  lotNumber: z.string().max(100).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  manufactureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  serialNumbers: z.array(z.string().max(100)).optional(),
}).strict();

export const createGrnSchema = z.object({
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(grnLotLineSchema).min(1),
}).strict();
export type CreateGrnInput = z.infer<typeof createGrnSchema>;

export const listGrnSchema = z.object({
  poId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListGrnInput = z.infer<typeof listGrnSchema>;

export const reverseGrnSchema = z.object({
  reason: z.string().max(500),
}).strict();
export type ReverseGrnInput = z.infer<typeof reverseGrnSchema>;
