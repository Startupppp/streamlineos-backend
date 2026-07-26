import { z } from "zod";

export const listReturnsSchema = z.object({
  status: z.enum(["DRAFT", "POSTED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;

const vendorReturnLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
  reason: z.enum(["DAMAGED", "WRONG_ITEM", "EXCESS", "EXPIRED", "QUALITY_REJECTED"]),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
});

export const createVendorReturnSchema = z.object({
  vendorId: z.number().int().positive(),
  poId: z.number().int().positive().optional(),
  grnId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(vendorReturnLineSchema).min(1),
});
export type CreateVendorReturnInput = z.infer<typeof createVendorReturnSchema>;

export const postVendorReturnSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type PostVendorReturnInput = z.infer<typeof postVendorReturnSchema>;

const customerReturnLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
  reason: z.string().max(500),
  disposition: z.enum(["RESTOCK", "QUARANTINE", "SCRAP"]),
  targetLocationId: z.number().int().positive().optional(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
});

export const createCustomerReturnSchema = z.object({
  soId: z.number().int().positive().optional(),
  shipmentId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(customerReturnLineSchema).min(1),
});
export type CreateCustomerReturnInput = z.infer<typeof createCustomerReturnSchema>;

export const postCustomerReturnSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type PostCustomerReturnInput = z.infer<typeof postCustomerReturnSchema>;
