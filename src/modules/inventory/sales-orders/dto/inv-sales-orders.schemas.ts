import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listSoSchema = z.object({
  status: z.enum([
    "DRAFT", "CONFIRMED", "PARTIALLY_RESERVED", "RESERVED",
    "PICKED", "PACKED", "SHIPPED", "PARTIALLY_SHIPPED", "INVOICED", "CANCELLED", "CLOSED",
  ]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListSoInput = z.infer<typeof listSoSchema>;

const soLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
  unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  lineOrder: z.number().int().min(0).default(0),
});

export const createSoSchema = z.object({
  clientId: z.number().int().positive().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shippingAddress: z.string().max(500).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).default("INR"),
  notes: z.string().max(2000).optional(),
  lines: z.array(soLineSchema).min(1),
}).strict();
export type CreateSoInput = z.infer<typeof createSoSchema>;

export const updateSoSchema = z.object({
  clientId: z.number().int().positive().optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shippingAddress: z.string().max(500).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(soLineSchema).min(1).optional(),
}).strict();
export type UpdateSoInput = z.infer<typeof updateSoSchema>;

const reserveAllocationSchema = z.object({
  soLineId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
  qty: z.number().positive(),
});

export const reserveSoSchema = z.object({
  warehouseId: z.number().int().positive().optional(),
  allocations: z.array(reserveAllocationSchema).optional(),
}).strict();
export type ReserveSoInput = z.infer<typeof reserveSoSchema>;

const pickLineSchema = z.object({
  soLineId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
  quantityPicked: z.number().positive(),
});

export const pickSoSchema = z.object({
  lines: z.array(pickLineSchema).min(1),
}).strict();
export type PickSoInput = z.infer<typeof pickSoSchema>;

export const packSoSchema = z.object({
  weight: z.number().positive().optional(),
  dimensionsL: z.number().positive().optional(),
  dimensionsW: z.number().positive().optional(),
  dimensionsH: z.number().positive().optional(),
}).strict();
export type PackSoInput = z.infer<typeof packSoSchema>;

export const shipSoSchema = z.object({
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  carrierId: z.number().int().positive().optional(),
  trackingNumber: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
}).strict();
export type ShipSoInput = z.infer<typeof shipSoSchema>;

export const cancelSoSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type CancelSoInput = z.infer<typeof cancelSoSchema>;
