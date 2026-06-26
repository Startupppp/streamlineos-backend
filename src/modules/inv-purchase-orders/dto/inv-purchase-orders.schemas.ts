import { z } from "zod";

export const listPoSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]).optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListPoInput = z.infer<typeof listPoSchema>;

export const poLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/),
  taxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  lineOrder: z.number().int().min(0).default(0),
});

export const createPoSchema = z.object({
  vendorId: z.number().int().positive(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  warehouseId: z.number().int().positive().optional(),
  currency: z.string().length(3).default("INR"),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1),
});
export type CreatePoInput = z.infer<typeof createPoSchema>;

export const grnLineSchema = z.object({
  poLineId: z.number().int().positive(),
  quantityReceived: z.number().positive(),
  qualityStatus: z.enum(["ACCEPTED", "REJECTED"]).default("ACCEPTED"),
  rejectionReason: z.string().max(500).optional(),
});

export const createGrnSchema = z.object({
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(grnLineSchema).min(1),
});
export type CreateGrnInput = z.infer<typeof createGrnSchema>;
