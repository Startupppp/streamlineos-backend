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
  /**
   * B1 — the dark-store inputs, accepted only while the `materials` pack is on.
   * The service refuses them otherwise rather than writing a column the
   * organisation cannot see, exactly as the product packs do.
   */
  facilityType: z.enum(["DARK_STORE", "WAREHOUSE", "YARD", "SITE_STORE"]).optional(),
  zone: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/, "Zone must be uppercase letters, digits, hyphens or underscores (e.g. HYD_NORTH)")
    .nullable()
    .optional(),
  zoneLabel: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(GEO_SAFE_RE, "Zone label contains unsupported characters")
    .nullable()
    .optional(),
  deliveryPromiseMinutes: z
    .number()
    .int("Delivery promise must be a whole number of minutes")
    .positive("A promise of zero minutes is not a promise — leave it unset if this site has none")
    .max(10080, "A promise longer than a week is almost always a typo")
    .nullable()
    .optional(),
  serviceRadiusKm: z
    .string()
    .trim()
    .regex(/^\d{1,4}(\.\d{1,2})?$/, "Service radius must be a number with up to 2 decimal places")
    .nullable()
    .optional(),
  latitude: z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, "Latitude must be a decimal with up to 6 places")
    .refine((v) => Math.abs(Number(v)) <= 90, "Latitude must be between -90 and 90")
    .nullable()
    .optional(),
  longitude: z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, "Longitude must be a decimal with up to 6 places")
    .refine((v) => Math.abs(Number(v)) <= 180, "Longitude must be between -180 and 180")
    .nullable()
    .optional(),
  isDefault: z.boolean().default(false),
  branchId: z.string().trim().max(100).optional(),
  managerUserId: z.string().trim().optional(),
  isActive: z.boolean().optional(),
}).strict();
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

/** B1. The keys the `materials` pack owns, named once so gate and stripper agree. */
export const WAREHOUSE_MATERIALS_FIELD_KEYS = [
  "facilityType", "zone", "zoneLabel", "deliveryPromiseMinutes",
  "serviceRadiusKm", "latitude", "longitude",
] as const;

export const updateWarehouseSchema = createWarehouseSchema.partial().strict();
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
}).strict();
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = createLocationSchema.partial().strict();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const listWarehouseStockSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListWarehouseStockInput = z.infer<typeof listWarehouseStockSchema>;

export const listWarehousesSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  isDefault: queryBoolean.optional(),
  country: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  /**
   * B1. The zone board asks "which stores serve the north" and the transfer
   * suggester asks "which of them are dark stores"; both are indexed on
   * `(org_id, …)`. Ignored while the `materials` pack is off — no row carries a
   * zone then, so the filter would empty the list rather than narrow it.
   */
  zone: z.string().trim().max(40).optional(),
  facilityType: z.enum(["DARK_STORE", "WAREHOUSE", "YARD", "SITE_STORE"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(100, 100),
}).strict();
export type ListWarehousesInput = z.infer<typeof listWarehousesSchema>;

/** INV-202. Where should this quantity of this variant go in this warehouse? */
export const suggestPutawaySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive(),
    productVariantId: z.coerce.number().int().positive(),
    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  })
  .strict();
export type SuggestPutawayInput = z.infer<typeof suggestPutawaySchema>;

/** A7. Grant one person warehouse scope. Identity of the grantor comes from the token. */
export const grantWarehouseUserSchema = z
  .object({
    userId: z.string().trim().min(1).max(255),
  })
  .strict();
export type GrantWarehouseUserInput = z.infer<typeof grantWarehouseUserSchema>;

export const listWarehouseUsersSchema = z
  .object({
    page: pageNumberField,
    limit: pageSizeField(20, 100),
  })
  .strict();
export type ListWarehouseUsersInput = z.infer<typeof listWarehouseUsersSchema>;

export const listAssignableUsersSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    limit: pageSizeField(50, 50),
  })
  .strict();
export type ListAssignableUsersInput = z.infer<typeof listAssignableUsersSchema>;
