import { pgTable, text, serial, timestamp, decimal, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invAiInsightStatusEnum } from "../enums";
import { organizations } from "../auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";

export const invReorderRules = pgTable("inv_reorder_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  minQty: decimal("min_qty", { precision: 18, scale: 4 }).notNull(),
  maxQty: decimal("max_qty", { precision: 18, scale: 4 }),
  reorderQty: decimal("reorder_qty", { precision: 18, scale: 4 }),
  vendorId: integer("vendor_id"),
  leadTimeDays: integer("lead_time_days"),
  safetyStock: decimal("safety_stock", { precision: 18, scale: 4 }).default("0"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_reorder_org_variant_wh").on(table.orgId, table.productVariantId, table.warehouseId),
  index("idx_inv_reorder_org").on(table.orgId),
  index("idx_inv_reorder_variant").on(table.productVariantId),
]);

export const invAiInsights = pgTable("inv_ai_insights", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  insightType: text("insight_type").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceRefs: jsonb("source_refs").$type<Record<string, unknown>>(),
  status: invAiInsightStatusEnum("status").default("NEW").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_inv_ai_insights_org_status").on(table.orgId, table.status),
]);

export const invReorderRulesRelations = relations(invReorderRules, ({ one }) => ({
  organization: one(organizations, { fields: [invReorderRules.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invReorderRules.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invReorderRules.warehouseId], references: [invWarehouses.id] }),
}));

export const invAiInsightsRelations = relations(invAiInsights, ({ one }) => ({
  organization: one(organizations, { fields: [invAiInsights.orgId], references: [organizations.id] }),
}));
