import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

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

export const DRUG_SCHEDULES = ["OTC", "H", "H1", "X", "NARCOTIC"] as const;
export const SALE_MODES = ["PACKED", "LOOSE"] as const;
export const QTY_INPUT_MODES = ["WHOLE", "DECIMAL", "SCALE"] as const;

/**
 * E3. MRP in integer paise, never rupees and never a float. A ceiling that
 * arrives as 12550 and leaves as 125.49999999999999 is the class of error nobody
 * can argue with afterwards, and JSON has one number type, so the unit has to be
 * the minor one. Capped an order of magnitude above anything real so a rupee
 * figure pasted into a paise field is refused rather than stored as ₹1.25.
 */
const mrpPaiseSchema = z
  .number()
  .int("MRP must be a whole number of paise")
  .positive("MRP must be greater than zero — leave it unset if there is no printed price")
  .max(1_000_000_000, "MRP is in paise, not rupees");

/**
 * E3 — the pharmacy inputs, accepted only while the `pharmacy` pack is on. The
 * service refuses them otherwise rather than writing a column the organisation
 * cannot see. `null` clears, `undefined` leaves alone.
 */
export const productPharmacyFields = {
  mrpPaise: mrpPaiseSchema.nullable().optional(),
  mrpRequired: z.boolean().optional(),
  drugSchedule: z.enum(DRUG_SCHEDULES).nullable().optional(),
  isHighAlert: z.boolean().optional(),
  lasaGroup: z.string().trim().min(1).max(100).nullable().optional(),
};

export const PRODUCT_PHARMACY_FIELD_KEYS = [
  "mrpPaise", "mrpRequired", "drugSchedule", "isHighAlert", "lasaGroup",
] as const;

/**
 * E4 — the kirana inputs, accepted only while the `kirana` pack is on. Not
 * nullable: all three are NOT NULL with a default, so there is no "unset" state
 * to return them to — a SKU is always either packed or loose.
 */
export const productKiranaFields = {
  saleMode: z.enum(SALE_MODES).optional(),
  quantityInputMode: z.enum(QTY_INPUT_MODES).optional(),
  quantityPrecision: z.number().int().min(0).max(4).optional(),
};

export const PRODUCT_KIRANA_FIELD_KEYS = [
  "saleMode", "quantityInputMode", "quantityPrecision",
] as const;

export const MATERIAL_FAMILIES = [
  "CEMENT_AGGREGATE", "STEEL_REBAR", "BRICK_BLOCK", "TILE_STONE", "PAINT_COATING",
  "PLUMBING", "ELECTRICAL", "SANITARYWARE", "WOOD_PANEL", "GLASS_MIRROR",
  "HARDWARE_FASTENER", "ADHESIVE_CHEMICAL", "FALSE_CEILING", "LIGHTING", "OTHER",
] as const;

/**
 * B1 — the construction and interior-materials inputs, accepted only while the
 * `materials` pack is on. The service refuses them otherwise rather than writing
 * a column the organisation cannot see. `null` clears, `undefined` leaves alone.
 *
 * `packSize`, `leadTimeDays` and `reorderQuantity` carry their own bounds here
 * as well as in the database CHECKs: the constraint is what makes the bad value
 * impossible, the schema is what turns it into a message a person can act on
 * instead of a 500 from a constraint name.
 */
export const productMaterialsFields = {
  brand: z.string().trim().min(1).max(120).nullable().optional(),
  materialGrade: z.string().trim().min(1).max(60).nullable().optional(),
  finish: z.string().trim().min(1).max(60).nullable().optional(),
  colour: z.string().trim().min(1).max(60).nullable().optional(),
  dimensionLabel: z.string().trim().min(1).max(80).nullable().optional(),
  materialFamily: z.enum(MATERIAL_FAMILIES).nullable().optional(),
  packSize: z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, "Pack size must be a decimal with up to 4 places")
    .refine((v) => Number(v) > 0, "Pack size must be greater than zero — leave it unset if the item is not packed")
    .nullable()
    .optional(),
  supplierCode: z.string().trim().min(1).max(100).nullable().optional(),
  leadTimeDays: z
    .number()
    .int("Lead time must be a whole number of days")
    .min(0, "Lead time cannot be negative")
    .max(365, "Lead time longer than a year is almost always a typo")
    .nullable()
    .optional(),
  reorderQuantity: z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, "Reorder quantity must be a decimal with up to 4 places")
    .refine((v) => Number(v) > 0, "Reorder quantity must be greater than zero — leave it unset to decide each time")
    .nullable()
    .optional(),
};

export const PRODUCT_MATERIALS_FIELD_KEYS = [
  "brand", "materialGrade", "finish", "colour", "dimensionLabel",
  "materialFamily", "packSize", "supplierCode", "leadTimeDays", "reorderQuantity",
] as const;

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
  /**
   * B1 — the two axes a materials catalogue is actually browsed by. Both are
   * indexed (partial, on `org_id`), so they narrow the scan rather than filtering
   * a full one. Ignored, not refused, while the `materials` pack is off: a stale
   * bookmark should show the catalogue, not an error.
   */
  brand: z.string().trim().max(120).optional(),
  materialFamily: z.enum(MATERIAL_FAMILIES).optional(),
  search: z.string().trim().max(200).optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
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
  ...productPharmacyFields,
  ...productKiranaFields,
  ...productMaterialsFields,
}).strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema.partial().strict();
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

export const updateVariantSchema = createVariantSchema.partial().strict();
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
  page: pageNumberField,
  limit: pageSizeField(50, 100),
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

/**
 * E4 — what a quantity for this SKU may look like, and, when one is supplied,
 * the conversion snapshot a document line would record for it.
 *
 * The quantity arrives as a **string**. A scale reading routed through a JSON
 * number has already been through a float by the time this schema sees it, and
 * `2.995` × 1000 in floating point is 2994.9999999999995 grams — a permanent
 * discrepancy that no stock count will ever explain.
 */
export const quantityCaptureSchema = z.object({
  quantity: z.string().trim().regex(DECIMAL_PATTERN, "quantity must be a decimal with up to 4 places").optional(),
  /** The unit the quantity was entered in. Absent means the product's own stock unit. */
  uomId: z.coerce.number().int().positive().optional(),
}).strict();
export type QuantityCaptureQuery = z.infer<typeof quantityCaptureSchema>;

/** E3 — the Schedule H1 register scope. A list, so it pages like every other list. */
export const h1RegisterSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type H1RegisterQuery = z.infer<typeof h1RegisterSchema>;
