import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invProductStatusEnum, invProductTypeEnum, invTrackingMethodEnum, invCostingMethodEnum } from "../enums";
import { organizations, users } from "../auth";

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
  index("idx_inv_categories_org").on(table.orgId),
  index("idx_inv_categories_parent").on(table.parentCategoryId),
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
}, (table) => [
  uniqueIndex("uniq_inv_products_org_sku").on(table.orgId, table.sku),
  index("idx_inv_products_org_status").on(table.orgId, table.status),
  index("idx_inv_products_category").on(table.categoryId),
  index("idx_inv_products_barcode").on(table.barcode),
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
}, (table) => [
  uniqueIndex("uniq_inv_variants_org_sku").on(table.orgId, table.sku),
  index("idx_inv_variants_product").on(table.productId),
  index("idx_inv_variants_barcode").on(table.barcode),
]);

export const invUomRelations = relations(invUom, ({ one }) => ({
  organization: one(organizations, { fields: [invUom.orgId], references: [organizations.id] }),
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
