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
