import { z } from "zod";

export const listProductsSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE", "DISCONTINUED"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(255),
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.number().int().positive().optional(),
  uomId: z.number().int().positive().optional(),
  costPrice: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  sellingPrice: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  reorderPoint: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  minStockLevel: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  maxStockLevel: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  hasVariants: z.boolean().default(false),
  imageUrl: z.string().url().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const createVariantSchema = z.object({
  name: z.string().trim().min(1).max(255),
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(100).optional(),
  costPrice: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  sellingPrice: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0"),
  attributeValues: z.record(z.string(), z.string()).default({}),
});
export type CreateVariantInput = z.infer<typeof createVariantSchema>;

export const updateVariantSchema = createVariantSchema.partial();
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(255),
  parentCategoryId: z.number().int().positive().optional(),
  description: z.string().trim().max(1000).optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const createUomSchema = z.object({
  name: z.string().trim().min(1).max(100),
  abbreviation: z.string().trim().min(1).max(20),
});
export type CreateUomInput = z.infer<typeof createUomSchema>;

export const listVariantsSchema = z.object({
  activeOnly: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
});
export type ListVariantsInput = z.infer<typeof listVariantsSchema>;
