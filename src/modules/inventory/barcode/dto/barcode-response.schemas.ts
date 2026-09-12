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

/** `Gs1ParseResult` (`gs1.ts`). Every optional field is absent, never null. */
const gs1ParseSchema = z.object({
  raw: z.string(),
  isGs1: z.boolean(),
  gtin: z.string().optional(),
  lotNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  expiryDate: z.string().optional(),
  productionDate: z.string().optional(),
  bestBeforeDate: z.string().optional(),
  elements: z.array(z.object({ ai: z.string(), value: z.string() })),
  unparsed: z.string().optional(),
});

/**
 * `ScanResult` (`dto/inv-barcode.schemas.ts`).
 *
 * `variant`, `lot` and `serial` are each optional AND nullable, and the
 * difference is real: a GS1 payload that named a GTIN nothing carries returns
 * `null`, while a payload that never mentioned one omits the key. `lookup` is
 * present only on the non-GS1 path, where the plain code was resolved instead.
 */
const scanResultSchema = z.object({
  parsed: gs1ParseSchema,
  variant: z.object({
    id: z.number().int(),
    productId: z.number().int(),
    name: z.string(),
    sku: z.string(),
    isActive: z.boolean(),
  }).nullable().optional(),
  lot: z.object({
    id: z.number().int(),
    productVariantId: z.number().int(),
    lotNumber: z.string(),
    status: z.string(),
    expiryDate: z.string().nullable(),
  }).nullable().optional(),
  serial: z.object({
    id: z.number().int(),
    productVariantId: z.number().int(),
    serialNumber: z.string(),
    status: z.string(),
    currentLocationId: z.number().int().nullable(),
  }).nullable().optional(),
  lookup: barcodeLookupResponseSchema.optional(),
  warnings: z.array(z.string()),
});

export const barcodeScanResponseSchema = scanResultSchema;

/**
 * `captured` is false on an idempotent replay: the fact was emitted by the
 * first request, and saying so is the difference between "recorded" and
 * "recorded again".
 */
export const barcodeCaptureScanResponseSchema = scanResultSchema.extend({
  captured: z.boolean(),
});
