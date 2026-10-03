import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

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
export const listWarehousesResponseSchema = itemsPagedSchema(invWarehouseSchema.extend({
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

/**
 * INV-202 — where the goods would fit. Advisory: the engine still refuses a
 * putaway that does not, so a suggestion is never an authorisation.
 */
export const suggestPutawayResponseSchema = z.array(
  z.object({
    locationId: z.number().int(),
    code: z.string(),
    name: z.string(),
    /** Null where the bin records no capacity, which means unlimited. */
    capacity: z.string().nullable(),
    onHand: z.string(),
    remaining: z.string().nullable(),
    holdsVariant: z.boolean(),
    fits: z.boolean(),
    /** True when this bin sits inside a zone the slotting rules point at. */
    inSlot: z.boolean(),
    /** The rule that put it there, for a screen that has to explain the order. */
    slotRuleName: z.string().nullable(),
  }),
);

/**
 * A7 — who may transact in a warehouse.
 *
 * The identity fields are the explicit minimal projection §3 requires of any
 * read that touches the global `users` table; nothing here comes from an
 * unprojected relation.
 */
const warehouseUserSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

export const listWarehouseUsersResponseSchema = itemsPagedSchema(
  warehouseUserSchema.extend({
    grantedBy: z.string(),
    grantedByName: z.string().nullable(),
    grantedAt: wireDate(),
  }),
);

/** A picker feed of live members who do not already hold this warehouse. */
export const listAssignableUsersResponseSchema = z.array(warehouseUserSchema);

/** False when the grant already stood: a repeat is the same state, not an error. */
export const grantWarehouseUserResponseSchema = z.object({
  granted: z.boolean(),
});

export const revokeWarehouseUserResponseSchema = z.object({
  revoked: z.literal(true),
});
