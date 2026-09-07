import { z } from "zod";

const productResultSchema = z.object({
  type: z.literal("product"),
  productId: z.number().int(),
  name: z.string(),
  sku: z.string().nullable(),
  status: z.string().nullable(),
  totalOnHand: z.string(),
});

const variantResultSchema = z.object({
  type: z.literal("variant"),
  variantId: z.number().int(),
  productId: z.number().int(),
  name: z.string(),
  sku: z.string(),
  isActive: z.boolean(),
  totalOnHand: z.string(),
});

const lotResultSchema = z.object({
  type: z.literal("lot"),
  lotId: z.number().int(),
  variantId: z.number().int(),
  lotNumber: z.string(),
  status: z.string(),
});

const serialResultSchema = z.object({
  type: z.literal("serial"),
  serialId: z.number().int(),
  variantId: z.number().int(),
  serialNumber: z.string(),
  status: z.string(),
  currentLocationId: z.number().int().nullable(),
});

const locationResultSchema = z.object({
  type: z.literal("location"),
  locationId: z.number().int(),
  warehouseId: z.number().int(),
  name: z.string(),
  code: z.string(),
  locationType: z.string().nullable(),
  isActive: z.boolean(),
});

const notFoundResultSchema = z.object({
  type: z.literal("not_found"),
});

export const barcodeLookupResponseSchema = z.discriminatedUnion("type", [
  productResultSchema,
  variantResultSchema,
  lotResultSchema,
  serialResultSchema,
  locationResultSchema,
  notFoundResultSchema,
]);
