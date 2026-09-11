import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const invLocationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  warehouseId: z.number().int(),
  parentLocationId: z.number().int().nullable(),
  name: z.string(),
  code: z.string(),
  locationType: z.string(),
  isPickable: z.boolean(),
  isReceivable: z.boolean(),
  isActive: z.boolean(),
  capacity: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const invWarehouseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  code: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  branchId: z.string().nullable(),
  managerUserId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// A bare array: the warehouse picker reads the list whole.
export const listWarehousesResponseSchema = z.array(invWarehouseSchema.extend({
  _count: z.object({ locations: z.number().int() }),
}));

export const getWarehouseResponseSchema = invWarehouseSchema.extend({
  locations: z.array(invLocationSchema.extend({
    children: z.array(invLocationSchema),
  })),
});

export const listLocationsResponseSchema = z.array(invLocationSchema);

export const getWarehouseStockResponseSchema = z.object({
  items: z.array(z.object({
    locationId: z.number().int(),
    locationCode: z.string(),
    locationName: z.string(),
    productVariantId: z.number().int(),
    variantSku: z.string(),
    variantName: z.string(),
    productId: z.number().int(),
    productName: z.string(),
    onHand: z.string(),
    committed: z.string(),
    onOrder: z.string(),
  })),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});
