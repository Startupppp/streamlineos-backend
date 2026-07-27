import { pgTable, text, integer, boolean, timestamp, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { crmProducts } from "./products";

export const crmPricebooks = pgTable("crm_pricebooks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  currency: text("currency").default("INR").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_crm_pricebooks_org_name").on(table.orgId, table.name),
  index("idx_crm_pricebooks_org").on(table.orgId),
  unique("uniq_crm_pricebooks_org_id").on(table.orgId, table.id),
]);

export const crmPricebookEntries = pgTable("crm_pricebook_entries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pricebookId: text("pricebook_id").references(() => crmPricebooks.id, { onDelete: "cascade" }).notNull(),
  productId: integer("product_id").references(() => crmProducts.id, { onDelete: "cascade" }).notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  minQuantity: integer("min_quantity").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_pb_entry").on(table.orgId, table.pricebookId, table.productId, table.minQuantity),
  index("idx_crm_pb_entries_pricebook").on(table.pricebookId),
  index("idx_crm_pb_entries_product").on(table.productId),
  unique("uniq_crm_pricebook_entries_org_id").on(table.orgId, table.id),
]);

export const crmQuoteSettings = pgTable("crm_quote_settings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  maxDiscountPercent: integer("max_discount_percent"),
  requirePricebookPrice: boolean("require_pricebook_price").default(false).notNull(),
  defaultExpiryDays: integer("default_expiry_days").default(30).notNull(),
  allowPriceOverride: boolean("allow_price_override").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_quote_settings_org").on(table.orgId),
  unique("uniq_crm_quote_settings_org_id").on(table.orgId, table.id),
]);

export const crmQuoteTemplates = pgTable("crm_quote_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  branding: jsonb("branding").$type<Record<string, unknown>>(),
  terms: text("terms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_crm_quote_templates_org_name").on(table.orgId, table.name),
  index("idx_crm_quote_templates_org").on(table.orgId),
  unique("uniq_crm_quote_templates_org_id").on(table.orgId, table.id),
]);

export const crmPricebooksRelations = relations(crmPricebooks, ({ one, many }) => ({
  organization: one(organizations, { fields: [crmPricebooks.orgId], references: [organizations.id] }),
  entries: many(crmPricebookEntries),
}));

export const crmPricebookEntriesRelations = relations(crmPricebookEntries, ({ one }) => ({
  pricebook: one(crmPricebooks, { fields: [crmPricebookEntries.pricebookId], references: [crmPricebooks.id] }),
  product: one(crmProducts, { fields: [crmPricebookEntries.productId], references: [crmProducts.id] }),
  organization: one(organizations, { fields: [crmPricebookEntries.orgId], references: [organizations.id] }),
}));

export const crmQuoteSettingsRelations = relations(crmQuoteSettings, ({ one }) => ({
  organization: one(organizations, { fields: [crmQuoteSettings.orgId], references: [organizations.id] }),
}));

export const crmQuoteTemplatesRelations = relations(crmQuoteTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [crmQuoteTemplates.orgId], references: [organizations.id] }),
}));
