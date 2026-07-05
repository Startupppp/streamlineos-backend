import { z } from "zod";

export const createWarehouseSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  isDefault: z.boolean().default(false),
  branchId: z.string().trim().max(100).optional(),
  managerUserId: z.string().trim().optional(),
  isActive: z.boolean().optional(),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = createWarehouseSchema.partial();
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50),
  locationType: z.enum(["ZONE", "AISLE", "RACK", "BIN", "RECEIVING", "SHIPPING", "QUARANTINE", "SCRAP", "TRANSIT", "RETURNS"]),
  parentLocationId: z.number().int().positive().optional(),
  isPickable: z.boolean().optional(),
  isReceivable: z.boolean().optional(),
  isSellable: z.boolean().optional(),
  capacity: z.string().trim().regex(/^\d+(\.\d+)?$/, "Must be a valid decimal number").optional(),
  isActive: z.boolean().optional(),
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = createLocationSchema.partial();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const listWarehouseStockSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListWarehouseStockInput = z.infer<typeof listWarehouseStockSchema>;
