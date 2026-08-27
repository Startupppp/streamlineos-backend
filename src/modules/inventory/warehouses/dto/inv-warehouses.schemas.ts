import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

const WAREHOUSE_NAME_RE = /^[\p{L}\p{N}\s\-&.,()'/]+$/u;
const WAREHOUSE_CODE_RE = /^[A-Z0-9][A-Z0-9\-_]*$/;
const ADDRESS_SAFE_RE = /^[\p{L}\p{N}\s\-.,#/()']+$/u;
const GEO_SAFE_RE = /^[\p{L}\p{N}\s\-.,'()]+$/u;

export const createWarehouseSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Warehouse name is required")
    .max(100, "Name must be 100 characters or fewer")
    .regex(WAREHOUSE_NAME_RE, "Name contains unsupported characters"),
  code: z
    .string()
    .trim()
    .min(2, "Code must be at least 2 characters")
    .max(20, "Code must be 20 characters or fewer")
    .regex(WAREHOUSE_CODE_RE, "Code must be uppercase letters/numbers, optionally separated by hyphens or underscores (e.g. WH-001)")
    .transform((v) => v.toUpperCase()),
  address: z
    .string()
    .trim()
    .max(255, "Address must be 255 characters or fewer")
    .regex(ADDRESS_SAFE_RE, "Address contains unsupported characters")
    .optional()
    .or(z.literal("")),
  city: z
    .string()
    .trim()
    .max(100, "City must be 100 characters or fewer")
    .regex(GEO_SAFE_RE, "City contains unsupported characters")
    .optional()
    .or(z.literal("")),
  state: z
    .string()
    .trim()
    .max(100, "State must be 100 characters or fewer")
    .regex(GEO_SAFE_RE, "State contains unsupported characters")
    .optional()
    .or(z.literal("")),
  country: z
    .string()
    .trim()
    .max(100, "Country must be 100 characters or fewer")
    .regex(GEO_SAFE_RE, "Country contains unsupported characters")
    .optional()
    .or(z.literal("")),
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
  page: pageNumberField,
  limit: pageSizeField(50, 100),
});
export type ListWarehouseStockInput = z.infer<typeof listWarehouseStockSchema>;

export const listWarehousesSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  isDefault: queryBoolean.optional(),
  country: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  page: pageNumberField,
  limit: pageSizeField(100, 100),
});
export type ListWarehousesInput = z.infer<typeof listWarehousesSchema>;
