import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

export const invUomSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  abbreviation: z.string(),
  category: z.string().nullable(),
  ratioToBase: z.string().nullable(),
  roundingPrecision: z.number().int().nullable(),
  isBase: z.boolean().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const invCategorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  parentCategoryId: z.number().int().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const invProductVariantSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  productId: z.number().int(),
  name: z.string(),
  sku: z.string(),
  barcode: z.string().nullable(),
  costPrice: z.string().optional(),
  sellingPrice: z.string(),
  attributeValues: z.record(z.string(), z.string()),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const invProductSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  categoryId: z.number().int().nullable(),
  uomId: z.number().int().nullable(),
  name: z.string(),
  sku: z.string(),
  barcode: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  productType: z.string().nullable(),
  trackingMethod: z.string().nullable(),
  costingMethod: z.string().nullable(),
  standardCost: z.string().nullable().optional(),
  purchaseUomId: z.number().int().nullable(),
  salesUomId: z.number().int().nullable(),
  defaultVendorId: z.number().int().nullable(),
  reorderEnabled: z.boolean().nullable(),
  allowNegativeStock: z.boolean().nullable(),
  costPrice: z.string().optional(),
  sellingPrice: z.string(),
  reorderPoint: z.string(),
  minStockLevel: z.string(),
  maxStockLevel: z.string(),
  hasVariants: z.boolean(),
  imageUrl: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listProductsResponseSchema = itemsPagedSchema(
  invProductSchema.extend({
    category: z.object({ id: z.number().int(), name: z.string() }).nullable(),
    uom: z.object({ id: z.number().int(), name: z.string(), abbreviation: z.string() }).nullable(),
    variants: z.array(z.object({ id: z.number().int(), sku: z.string(), name: z.string(), isActive: z.boolean() })),
  }),
);

export const getProductResponseSchema = invProductSchema.extend({
  category: invCategorySchema.nullable(),
  uom: invUomSchema.nullable(),
  variants: z.array(invProductVariantSchema),
  creator: z.object({ id: z.string(), name: z.string().nullable() }),
});

export const listCategoriesResponseSchema = z.array(invCategorySchema);

export const listUomResponseSchema = z.array(invUomSchema);

export const listVariantsResponseSchema = z.object({
  items: z.array(z.object({
    id: z.number().int(),
    productId: z.number().int(),
    productName: z.string(),
    name: z.string(),
    sku: z.string(),
    costPrice: z.string().optional(),
    isActive: z.boolean(),
  })),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

/** E2 — `LineTaxSnapshot`. `taxRate`/`taxAmount` are exact decimal strings, never floats. */
export const resolveLineTaxResponseSchema = z.object({
  hsnCode: z.string().nullable(),
  taxTreatment: z.string().nullable(),
  gstMode: z.string().nullable(),
  taxRate: z.string(),
  taxAmount: z.string(),
});

const pharmacyClassificationSchema = z.object({
  mrpPaise: z.number().int().nullable(),
  mrpRequired: z.boolean(),
  drugSchedule: z.string().nullable(),
  isHighAlert: z.boolean(),
  lasaGroup: z.string().nullable(),
  trackingMethod: z.string().nullable(),
});

export const pharmacyProfileResponseSchema = z.object({
  packEnabled: z.boolean(),
  productId: z.number().int(),
  /** Null with the pack off — the SKU is still resolved, it just carries no classification. */
  classification: pharmacyClassificationSchema.nullable(),
  safety: z.object({
    alerts: z.array(
      z.object({ code: z.string(), disposition: z.string(), message: z.string() }),
    ),
    /** Declared as the literal it is: nothing in E3 refuses a dispense. */
    blocksDispense: z.literal(false),
    acknowledgementRequired: z.boolean(),
  }),
  confusableWith: z.array(
    z.object({ productId: z.number().int(), sku: z.string(), name: z.string() }),
  ),
  batches: z.array(
    z.object({
      lotId: z.number().int(),
      lotNumber: z.string(),
      /** `inv_lots.expiry_date` is a `date`, which drizzle hands back as text. */
      expiryDate: z.string().nullable(),
      status: z.string(),
      mrpPaise: z.number().int().nullable(),
    }),
  ),
});

export const receiptRequirementsResponseSchema = z.object({
  mrpRequired: z.boolean(),
  lotRequired: z.boolean(),
  expiryRequired: z.boolean(),
  suggestedMrpPaise: z.number().int().nullable(),
});

const uomRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
});

export const quantityCaptureResponseSchema = z.object({
  packEnabled: z.boolean(),
  productId: z.number().int(),
  rules: z
    .object({ saleMode: z.string(), inputMode: z.string(), precision: z.number().int() })
    .nullable(),
  stockUom: uomRefSchema.nullable(),
  purchaseUom: uomRefSchema.nullable(),
  salesUom: uomRefSchema.nullable(),
  conversions: z.array(
    z.object({
      uomId: z.number().int(),
      abbreviation: z.string(),
      factorToBase: z.string(),
    }),
  ),
  /** `ConvertedQuantity`, and null unless the caller supplied a quantity to convert. */
  snapshot: z
    .object({
      quantityEntered: z.string(),
      uomId: z.number().int().nullable(),
      uomFactor: z.string(),
      quantity: z.string(),
    })
    .nullable(),
});

/**
 * Two genuinely different payloads behind one route: the register is off — either
 * because the pharmacy pack is or because the jurisdiction flag is — or it is on and
 * returns the catalogue scope. `enabled` is the discriminator, and it is declared as a
 * literal on each arm so a reader can tell them apart from the document alone.
 */
export const h1RegisterResponseSchema = z.union([
  z.object({
    enabled: z.literal(false),
    reason: z.string(),
    message: z.string(),
  }),
  z.object({
    enabled: z.literal(true),
    format: z.literal("H1_REGISTER_SCOPE_V0"),
    /** Already an ISO string when the handler returns it, not a `Date`. */
    generatedAt: z.string(),
    authoritative: z.literal(false),
    disclaimer: z.string(),
    dispensingRows: z.null(),
    items: z.array(
      z.object({
        productId: z.number().int(),
        sku: z.string(),
        name: z.string(),
        drugSchedule: z.string().nullable(),
        mrpPaise: z.number().int().nullable(),
      }),
    ),
    pagination: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  }),
]);
