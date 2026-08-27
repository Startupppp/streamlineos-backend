import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invProductStatusEnum, invProductTypeEnum, invTrackingMethodEnum, invCostingMethodEnum, invBarcodeTypeEnum } from "../common/enums";
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
  costingMethod: invCostingMethodEnum("costing_method").default("WEIGHTED_AVERAGE"),
  standardCost: decimal("standard_cost", { precision: 18, scale: 4 }),
  purchaseUomId: integer("purchase_uom_id").references(() => invUom.id, { onDelete: "set null" }),
  salesUomId: integer("sales_uom_id").references(() => invUom.id, { onDelete: "set null" }),
  defaultVendorId: integer("default_vendor_id"),
  reorderEnabled: boolean("reorder_enabled").default(false),
  allowNegativeStock: boolean("allow_negative_stock"),
  costPrice: decimal("cost_price", { precision: 18, scale: 4 }).default("0").notNull(),
  sellingPrice: decimal("selling_price", { precision: 18, scale: 4 }).default("0").notNull(),
  reorderPoint: decimal("reorder_point", { precision: 18, scale: 4 }).default("0").notNull(),
  minStockLevel: decimal("min_stock_level", { precision: 18, scale: 4 }).default("0").notNull(),
  maxStockLevel: decimal("max_stock_level", { precision: 18, scale: 4 }).default("0").notNull(),
  hasVariants: boolean("has_variants").default(false).notNull(),
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
