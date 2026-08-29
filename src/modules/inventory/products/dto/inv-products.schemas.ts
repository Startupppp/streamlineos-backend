import { z } from "zod";

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const DECIMAL_PATTERN = /^\d+(\.\d{1,4})?$/;
/**
 * E2. HSN is 4, 6 or 8 digits for goods; SAC is 6 for services. Which length an
 * organisation uses is a returns-filing choice driven by turnover, so all three
 * are accepted and none is padded — a 4-digit code stored as 8 zero-padded
 * digits is a different code.
 */
const HSN_PATTERN = /^(\d{4}|\d{6}|\d{8})$/;
/** Percent, scale 2 — "18.00", not "0.18". */
const GST_RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

export const TAX_TREATMENTS = ["TAXABLE", "EXEMPT", "NIL_RATED", "ZERO_RATED", "NON_GST"] as const;

const hsnCodeSchema = z
  .string()
  .trim()
  .regex(HSN_PATTERN, "HSN/SAC code must be 4, 6 or 8 digits");

const gstRateSchema = z
  .string()
  .trim()
  .regex(GST_RATE_PATTERN, "GST rate must be a percentage with up to 2 decimal places")
  .refine((v) => Number(v) <= 100, "GST rate cannot exceed 100");

/**
 * E2. The tax inputs, accepted only while the `gst` pack is on — the service
 * refuses them otherwise rather than writing a column the organisation cannot
 * see. Nullable so a classification can be taken back off a SKU; `undefined`
 * leaves it alone, `null` clears it.
 */
export const productTaxFields = {
  hsnCode: hsnCodeSchema.nullable().optional(),
  taxTreatment: z.enum(TAX_TREATMENTS).nullable().optional(),
  gstRate: gstRateSchema.nullable().optional(),
};

/** The keys the `gst` pack owns, named once so the gate and the stripper agree. */
export const PRODUCT_TAX_FIELD_KEYS = ["hsnCode", "taxTreatment", "gstRate"] as const;

export const listProductsSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE", "DISCONTINUED"]).optional(),
  /**
   * A4. Show soft-deleted products too, so an operator can find one to restore.
   *
   * Opt-in and off by default: every ordinary read must keep excluding deleted
   * rows, and a caller has to ask for them deliberately. Without this the
   * restore endpoint's whole reason for existing was unreachable — nothing
   * could show a deleted product for somebody to press restore on.
   */
  includeDeleted: z.coerce.boolean().optional(),
  productType: z.enum(["STOCKABLE", "CONSUMABLE", "SERVICE"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListProductsInput = z.infer<typeof listProductsSchema>;

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(255),
  sku: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(SKU_PATTERN, "SKU must contain only uppercase letters, digits, hyphens, or underscores")
        .transform((v) => v.toUpperCase())
        .optional(),
    ),
  barcode: z.string().trim().max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.number().int().positive().optional(),
  uomId: z.number().int().positive().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "DISCONTINUED"]).optional(),
  productType: z.enum(["STOCKABLE", "CONSUMABLE", "SERVICE"]).optional(),
  trackingMethod: z.enum(["NONE", "LOT", "SERIAL"]).optional(),
  costingMethod: z.enum(["STANDARD", "WEIGHTED_AVERAGE", "FIFO"]).optional(),
  standardCost: z.string().regex(DECIMAL_PATTERN).optional(),
  purchaseUomId: z.number().int().positive().optional(),
  salesUomId: z.number().int().positive().optional(),
  defaultVendorId: z.number().int().positive().optional(),
  reorderEnabled: z.boolean().optional(),
  costPrice: z.string().regex(DECIMAL_PATTERN).default("0"),
  sellingPrice: z.string().regex(DECIMAL_PATTERN).default("0"),
  reorderPoint: z.string().regex(DECIMAL_PATTERN).default("0"),
  minStockLevel: z.string().regex(DECIMAL_PATTERN).default("0"),
  maxStockLevel: z.string().regex(DECIMAL_PATTERN).default("0"),
  hasVariants: z.boolean().default(false),
  imageUrl: z.string().url().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  ...productTaxFields,
}).strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const createVariantSchema = z.object({
  name: z.string().trim().min(1).max(255),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(SKU_PATTERN, "SKU must contain only uppercase letters, digits, hyphens, or underscores"),
  barcode: z.string().trim().max(100).optional(),
  costPrice: z.string().regex(DECIMAL_PATTERN).default("0"),
  sellingPrice: z.string().regex(DECIMAL_PATTERN).default("0"),
  attributeValues: z.record(z.string(), z.string()).default({}),
}).strict();
export type CreateVariantInput = z.infer<typeof createVariantSchema>;

export const updateVariantSchema = createVariantSchema.partial();
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

const VALID_NAME_RE = /[a-zA-Z0-9]/;

export const createCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Category name is required.")
    .min(2, "Name must be at least 2 characters.")
    .max(100, "Name must be 100 characters or fewer.")
    .refine((v) => VALID_NAME_RE.test(v), "Name must contain at least one letter or number."),
  parentCategoryId: z.number().int().positive().optional(),
  description: z.string().trim().max(500, "Description must be 500 characters or fewer.").optional(),
}).strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const createUomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Unit name is required.")
    .max(100, "Name must be 100 characters or fewer."),
  abbreviation: z
    .string()
    .trim()
    .min(1, "Abbreviation is required.")
    .max(20, "Abbreviation must be 20 characters or fewer."),
  category: z.string().trim().max(100).optional(),
  ratioToBase: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .refine((v) => parseFloat(v) > 0, { message: "ratioToBase must be greater than 0" })
    .optional(),
  roundingPrecision: z.number().int().min(0).max(6).optional(),
  isBase: z.boolean().optional(),
}).strict();
export type CreateUomInput = z.infer<typeof createUomSchema>;

export const listVariantsSchema = z.object({
  activeOnly: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ListVariantsInput = z.infer<typeof listVariantsSchema>;

export const updateCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Category name is required.")
    .min(2, "Name must be at least 2 characters.")
    .max(100, "Name must be 100 characters or fewer.")
    .refine((v) => VALID_NAME_RE.test(v), "Name must contain at least one letter or number.")
    .optional(),
  parentCategoryId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(500, "Description must be 500 characters or fewer.").nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const updateUomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Unit name is required.")
    .max(100, "Name must be 100 characters or fewer.")
    .optional(),
  abbreviation: z
    .string()
    .trim()
    .min(1, "Abbreviation is required.")
    .max(20, "Abbreviation must be 20 characters or fewer.")
    .optional(),
  category: z.string().trim().max(100).optional(),
  ratioToBase: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .refine((v) => parseFloat(v) > 0, { message: "ratioToBase must be greater than 0" })
    .optional(),
  roundingPrecision: z.number().int().min(0).max(6).optional(),
  isBase: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();
export type UpdateUomInput = z.infer<typeof updateUomSchema>;

/**
 * E2 — what a document line needs to know before it can be written.
 *
 * A GET with the taxable value in the query: this reads a classification and
 * computes one figure from it, and writes nothing.
 */
export const resolveLineTaxSchema = z.object({
  taxableAmount: z.string().trim().regex(DECIMAL_PATTERN, "taxableAmount must be a decimal with up to 4 places"),
  documentKind: z.enum(["PURCHASE", "SALE"]),
  taxRate: gstRateSchema.optional(),
}).strict();
export type ResolveLineTaxQuery = z.infer<typeof resolveLineTaxSchema>;
