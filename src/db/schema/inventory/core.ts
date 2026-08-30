import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, integer, bigint, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invProductStatusEnum, invProductTypeEnum, invTrackingMethodEnum, invCostingMethodEnum, invBarcodeTypeEnum, invTaxTreatmentEnum, invDrugScheduleEnum, invSaleModeEnum, invQtyInputModeEnum, invMeasureModeEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

export const invUom = pgTable("inv_uom", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  abbreviation: text("abbreviation").notNull(),
  category: text("category"),
  ratioToBase: decimal("ratio_to_base", { precision: 18, scale: 8 }).default("1"),
  roundingPrecision: integer("rounding_precision").default(2),
  isBase: boolean("is_base").default(false),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_uom_org_name").on(table.orgId, table.name),
  unique("uniq_inv_uom_org_id").on(table.orgId, table.id),
  index("idx_inv_uom_org").on(table.orgId),
]);

export const invCategories = pgTable("inv_categories", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  parentCategoryId: integer("parent_category_id"),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_categories_org_name").on(table.orgId, table.name),
  unique("uniq_inv_categories_org_id").on(table.orgId, table.id),
  index("idx_inv_categories_org").on(table.orgId),
  index("idx_inv_categories_parent").on(table.parentCategoryId),
  foreignKey({ columns: [table.parentCategoryId], foreignColumns: [table.id], name: "fk_inv_categories_parent" }).onDelete("set null"),
]);

export const invProducts = pgTable("inv_products", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  categoryId: integer("category_id").references(() => invCategories.id, { onDelete: "set null" }),
  uomId: integer("uom_id").references(() => invUom.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  barcode: text("barcode"),
  description: text("description"),
  status: invProductStatusEnum("status").default("ACTIVE").notNull(),
  productType: invProductTypeEnum("product_type").default("STOCKABLE"),
  trackingMethod: invTrackingMethodEnum("tracking_method").default("NONE"),
  /**
   * NEO-10 - whether this SKU's quantity is a count or a weight.
   *
   * `PIECES` for everything that was here before, so the column is inert until an
   * organisation deliberately marks a SKU as catch-weight. A catch-weight SKU
   * holds its ledger quantity in **weight**: that is the number that has to add
   * up across receipts and issues, and the piece count rides alongside on the
   * document for the person counting the bags.
   */
  measureMode: invMeasureModeEnum("measure_mode").default("PIECES").notNull(),
  costingMethod: invCostingMethodEnum("costing_method").default("WEIGHTED_AVERAGE"),
  standardCost: decimal("standard_cost", { precision: 18, scale: 4 }),
  purchaseUomId: integer("purchase_uom_id").references(() => invUom.id, { onDelete: "set null" }),
  salesUomId: integer("sales_uom_id").references(() => invUom.id, { onDelete: "set null" }),
  defaultVendorId: integer("default_vendor_id"),
  /**
   * INV-309. Supplier order policy. Null means unconstrained, which is the
   * common case; a zero would divide into the rounding as a false answer, so
   * the CHECK forbids it.
   */
  minOrderQty: decimal("min_order_qty", { precision: 18, scale: 4 }),
  orderMultiple: decimal("order_multiple", { precision: 18, scale: 4 }),
  reorderEnabled: boolean("reorder_enabled").default(false),
  allowNegativeStock: boolean("allow_negative_stock"),
  costPrice: decimal("cost_price", { precision: 18, scale: 4 }).default("0").notNull(),
  sellingPrice: decimal("selling_price", { precision: 18, scale: 4 }).default("0").notNull(),
  reorderPoint: decimal("reorder_point", { precision: 18, scale: 4 }).default("0").notNull(),
  minStockLevel: decimal("min_stock_level", { precision: 18, scale: 4 }).default("0").notNull(),
  maxStockLevel: decimal("max_stock_level", { precision: 18, scale: 4 }).default("0").notNull(),
  hasVariants: boolean("has_variants").default(false).notNull(),
  /**
   * E2 — the tax inputs, behind the `gst` pack.
   *
   * Inventory holds them and does not compute a return from them: what a supply
   * is classified as, and what rate that classification carries, is decided in
   * the catalogue by the person who knows the goods, and is consumed by
   * accounting. Nullable throughout, because an organisation that does not run
   * the pack never sees these fields and must not be forced to invent values for
   * them — and because "not classified yet" is a real state that a default of
   * `0%` would silently launder into "nil rated".
   *
   * `hsnCode` is 4, 6 or 8 digits for goods and 6 for services (SAC); the length
   * is a returns-filing choice, not a data-quality one, so all three are stored
   * as given rather than padded.
   *
   * `gstRate` is the SKU's default rate in percent, scale 2 — 18.00, not 0.18.
   * It is a *default* for a document line, never the line's authority: the line
   * snapshots what it was told at the moment it was written.
   */
  hsnCode: text("hsn_code"),
  taxTreatment: invTaxTreatmentEnum("tax_treatment"),
  gstRate: decimal("gst_rate", { precision: 5, scale: 2 }),
  /**
   * E3 — the pharmacy inputs, behind the `pharmacy` pack.
   *
   * `mrpPaise` is the maximum retail price currently printed on this SKU's
   * packs, in integer paise. Integer minor units and never a float: an MRP is a
   * legal ceiling, a pack sold one paisa above it is an offence, and a value
   * that arrives as 12550 and leaves as 125.49999999999999 is exactly the class
   * of error that cannot be argued with afterwards.
   *
   * It is a **default, not a snapshot**. It moves whenever the manufacturer
   * reprints, which is why it must never be what a dispense reads: the ceiling
   * that binds a counter is the one printed on the pack in their hand, and that
   * is a fact about the batch. The snapshots live on `inv_grn_lines.mrp_paise`
   * (what the pack said on the day it was received) and `inv_lots.mrp_paise`
   * (what every pack in that batch says, for as long as it is on the shelf) —
   * both written once at receipt and never updated, so revising this column
   * cannot retroactively change what unsold stock may be sold for.
   *
   * `mrpRequired` is the flag E3's receipt rule keys on: a SKU carrying it may
   * not be received without a batch MRP, because once the carton is broken and
   * the pack is on the shelf, the printed price is no longer recoverable from
   * anywhere.
   *
   * `drugSchedule` is what the counter is allowed to do. `isHighAlert` and
   * `lasaGroup` are the two safety flags: high-alert is a drug that causes
   * disproportionate harm when given wrongly, and a LASA group names the set of
   * products that look or sound like each other. A group rather than a boolean,
   * because "this one is confusable" is useless at the shelf and "this one is
   * confusable with those three, in those bins" is the whole warning.
   */
  mrpPaise: bigint("mrp_paise", { mode: "number" }),
  mrpRequired: boolean("mrp_required").default(false).notNull(),
  drugSchedule: invDrugScheduleEnum("drug_schedule"),
  isHighAlert: boolean("is_high_alert").default(false).notNull(),
  lasaGroup: text("lasa_group"),
  /**
   * E4 — the kirana inputs, behind the `kirana` pack.
   *
   * `saleMode` decides whether a sale may name a unit other than the one stock
   * is held in: a LOOSE SKU is measured out of bulk and needs a conversion to do
   * it, a PACKED one leaves in the unit it arrived in.
   *
   * `quantityInputMode` and `quantityPrecision` decide what an entered quantity
   * may look like, and they are a pair — WHOLE means precision 0 and nothing
   * else, and a measured mode means between one and four places, the ledger's
   * own scale. The CHECK below holds the pair together, because either one alone
   * is a setting that reads as configured while doing nothing: precision 3 on a
   * WHOLE SKU accepts 1.005 tins, and SCALE at precision 0 rejects every reading
   * a scale will ever send.
   */
  saleMode: invSaleModeEnum("sale_mode").default("PACKED").notNull(),
  quantityInputMode: invQtyInputModeEnum("quantity_input_mode").default("WHOLE").notNull(),
  quantityPrecision: integer("quantity_precision").default(0).notNull(),
  imageUrl: text("image_url"),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  // Partial: a deleted product must not hold its SKU hostage, and the scope is
  // the tenant — a bare unique index lets one organisation's code block another's.
  uniqueIndex("uniq_inv_products_org_sku_live").on(table.orgId, table.sku).where(sql`${table.deletedAt} IS NULL`),
  index("idx_inv_products_org_live").on(table.orgId, table.id).where(sql`${table.deletedAt} IS NULL`),
  unique("uniq_inv_products_org_id").on(table.orgId, table.id),
  index("idx_inv_products_org_status").on(table.orgId, table.status),
  index("idx_inv_products_category").on(table.categoryId),
  index("idx_inv_products_barcode").on(table.barcode),
  index("idx_inv_products_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
  index("idx_inv_products_sku_trgm").using("gin", table.sku.op("gin_trgm_ops")),
  // E2. The HSN summary of a return groups the catalogue by code, so the code
  // leads after the tenant. Partial, because most rows have no code until the
  // organisation runs the gst pack.
  index("idx_inv_products_org_hsn").on(table.orgId, table.hsnCode).where(sql`${table.hsnCode} IS NOT NULL`),
  // E2. A treatment that is not TAXABLE cannot carry a rate. Written as a
  // constraint rather than a service check because the pair is only ever
  // meaningful together, and a row that says "exempt at 18%" is not a validation
  // failure somebody can explain — it is two answers to one question.
  check(
    "chk_inv_products_tax_treatment_rate",
    sql`${table.taxTreatment} IS NULL OR ${table.taxTreatment} = 'TAXABLE' OR ${table.gstRate} IS NULL OR ${table.gstRate} = 0`,
  ),
  // E3. The confusable-set lookup: given this SKU's LASA group, which other SKUs
  // share it. Partial, because outside a pharmacy nothing carries a group at all.
  index("idx_inv_products_org_lasa_group").on(table.orgId, table.lasaGroup).where(sql`${table.lasaGroup} IS NOT NULL`),
  // E3. The register scope query walks the catalogue by schedule. Partial for the
  // same reason.
  index("idx_inv_products_org_drug_schedule").on(table.orgId, table.drugSchedule).where(sql`${table.drugSchedule} IS NOT NULL`),
  // E3. A negative ceiling is not a price. Zero is refused too: "free" and "we
  // have not recorded one" are different, and NULL already says the second.
  check("chk_inv_products_mrp_paise_positive", sql`${table.mrpPaise} IS NULL OR ${table.mrpPaise} > 0`),
  // E4. The pair, held together. See the column comment: either half alone is a
  // setting that reads as configured and does nothing.
  check(
    "chk_inv_products_qty_input_precision",
    sql`(${table.quantityInputMode} = 'WHOLE' AND ${table.quantityPrecision} = 0)
        OR (${table.quantityInputMode} <> 'WHOLE' AND ${table.quantityPrecision} BETWEEN 1 AND 4)`,
  ),
]);

export const invProductVariants = pgTable("inv_product_variants", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productId: integer("product_id").references(() => invProducts.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  barcode: text("barcode"),
  costPrice: decimal("cost_price", { precision: 18, scale: 4 }).default("0").notNull(),
  sellingPrice: decimal("selling_price", { precision: 18, scale: 4 }).default("0").notNull(),
  attributeValues: jsonb("attribute_values").$type<Record<string, string>>().default({}).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  /**
   * INV-206. Base units as integers -- grams and millimetres. A physical
   * measure has no fractional gram worth modelling, and integers cannot drift
   * the way this schema's decimal quantities repeatedly have.
   *
   * Nullable because most catalogues do not measure everything, and a missing
   * dimension has to read as "unknown" rather than as zero: zero fits in
   * anything, which is the wrong answer to give a packer.
   */
  weightGrams: integer("weight_grams"),
  lengthMm: integer("length_mm"),
  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_inv_product_variants_org_sku_live").on(table.orgId, table.sku).where(sql`${table.deletedAt} IS NULL`),
  index("idx_inv_product_variants_org_live").on(table.orgId, table.id).where(sql`${table.deletedAt} IS NULL`),
  unique("uniq_inv_product_variants_org_id").on(table.orgId, table.id),
  index("idx_inv_variants_product").on(table.productId),
  index("idx_inv_variants_barcode").on(table.barcode),
  index("idx_inv_variants_sku_trgm").using("gin", table.sku.op("gin_trgm_ops")),
]);

export const invProductUomConversions = pgTable("inv_product_uom_conversions", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productId: integer("product_id").notNull(),
  uomId: integer("uom_id").notNull(),
  factorToBase: decimal("factor_to_base", { precision: 18, scale: 8 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_product_uom_conversions_key").on(table.orgId, table.productId, table.uomId),
  unique("uniq_inv_product_uom_conversions_org_id").on(table.orgId, table.id),
  index("idx_inv_product_uom_conversions_product").on(table.orgId, table.productId),
  check("chk_inv_product_uom_conversions_factor", sql`factor_to_base > 0`),
  foreignKey({
    columns: [table.orgId, table.productId],
    foreignColumns: [invProducts.orgId, invProducts.id],
    name: "fk_inv_product_uom_conversions_org_product",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.uomId],
    foreignColumns: [invUom.orgId, invUom.id],
    name: "fk_inv_product_uom_conversions_org_uom",
  }),
]);

export const invBarcodes = pgTable("inv_barcodes", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productId: integer("product_id").references(() => invProducts.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  barcodeType: invBarcodeTypeEnum("barcode_type").default("GTIN").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_barcodes_org_code").on(table.orgId, table.code),
  unique("uniq_inv_barcodes_org_id").on(table.orgId, table.id),
  index("idx_inv_barcodes_product").on(table.orgId, table.productId),
  index("idx_inv_barcodes_variant").on(table.orgId, table.productVariantId),
  check(
    "chk_inv_barcodes_exclusive_arc",
    sql`(product_id IS NOT NULL AND product_variant_id IS NULL) OR (product_id IS NULL AND product_variant_id IS NOT NULL)`,
  ),
]);

export const invUomRelations = relations(invUom, ({ one, many }) => ({
  organization: one(organizations, { fields: [invUom.orgId], references: [organizations.id] }),
  conversions: many(invProductUomConversions),
}));

export const invProductUomConversionsRelations = relations(invProductUomConversions, ({ one }) => ({
  organization: one(organizations, { fields: [invProductUomConversions.orgId], references: [organizations.id] }),
  product: one(invProducts, { fields: [invProductUomConversions.productId], references: [invProducts.id] }),
  uom: one(invUom, { fields: [invProductUomConversions.uomId], references: [invUom.id] }),
}));

export const invBarcodesRelations = relations(invBarcodes, ({ one }) => ({
  organization: one(organizations, { fields: [invBarcodes.orgId], references: [organizations.id] }),
  product: one(invProducts, { fields: [invBarcodes.productId], references: [invProducts.id] }),
  productVariant: one(invProductVariants, { fields: [invBarcodes.productVariantId], references: [invProductVariants.id] }),
}));

export const invCategoriesRelations = relations(invCategories, ({ one, many }) => ({
  organization: one(organizations, { fields: [invCategories.orgId], references: [organizations.id] }),
  parent: one(invCategories, { fields: [invCategories.parentCategoryId], references: [invCategories.id], relationName: "categoryParent" }),
  children: many(invCategories, { relationName: "categoryParent" }),
  products: many(invProducts),
}));

export const invProductsRelations = relations(invProducts, ({ one, many }) => ({
  organization: one(organizations, { fields: [invProducts.orgId], references: [organizations.id] }),
  category: one(invCategories, { fields: [invProducts.categoryId], references: [invCategories.id] }),
  uom: one(invUom, { fields: [invProducts.uomId], references: [invUom.id], relationName: "baseUom" }),
  purchaseUom: one(invUom, { fields: [invProducts.purchaseUomId], references: [invUom.id], relationName: "purchaseUom" }),
  salesUom: one(invUom, { fields: [invProducts.salesUomId], references: [invUom.id], relationName: "salesUom" }),
  creator: one(users, { fields: [invProducts.createdBy], references: [users.id] }),
  variants: many(invProductVariants),
}));

export const invProductVariantsRelations = relations(invProductVariants, ({ one }) => ({
  organization: one(organizations, { fields: [invProductVariants.orgId], references: [organizations.id] }),
  product: one(invProducts, { fields: [invProductVariants.productId], references: [invProducts.id] }),
}));
