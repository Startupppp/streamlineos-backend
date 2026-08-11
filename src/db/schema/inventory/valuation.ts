import { pgTable, text, serial, timestamp, date, decimal, integer, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invStockTransactions } from "./stock";
import { invLocations } from "./warehouses";
import { invLots } from "./traceability";

export const invValuationLayers = pgTable("inv_valuation_layers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "restrict" }),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "restrict" }),
  stockTransactionId: integer("stock_transaction_id").references(() => invStockTransactions.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }).notNull(),
  totalValue: decimal("total_value", { precision: 18, scale: 4 }).notNull(),
  remainingQuantity: decimal("remaining_quantity", { precision: 18, scale: 4 }).notNull(),
  remainingValue: decimal("remaining_value", { precision: 18, scale: 4 }).notNull(),
  costingMethod: text("costing_method").notNull(),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_valuation_layers_org_id").on(table.orgId, table.id),
  index("idx_inv_val_layers_org_variant").on(table.orgId, table.productVariantId, table.createdAt),
  index("idx_inv_val_layers_remaining").on(table.orgId, table.productVariantId),
  index("idx_inv_val_layers_txn").on(table.stockTransactionId),
  index("idx_inv_val_layers_fifo").on(table.orgId, table.productVariantId, table.locationId, table.createdAt).where(sql`remaining_quantity > 0`),
]);

export const invValuationConsumptions = pgTable("inv_valuation_consumptions", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  stockTransactionId: integer("stock_transaction_id").notNull(),
  valuationLayerId: integer("valuation_layer_id").notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }).notNull(),
  totalCost: decimal("total_cost", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_val_consumptions_txn_layer").on(table.orgId, table.stockTransactionId, table.valuationLayerId),
  unique("uniq_inv_valuation_consumptions_org_id").on(table.orgId, table.id),
  index("idx_inv_val_consumptions_org_txn").on(table.orgId, table.stockTransactionId),
  index("idx_inv_val_consumptions_org_layer").on(table.orgId, table.valuationLayerId),
  foreignKey({
    columns: [table.orgId, table.stockTransactionId],
    foreignColumns: [invStockTransactions.orgId, invStockTransactions.id],
    name: "fk_inv_val_consumptions_org_txn",
  }),
  foreignKey({
    columns: [table.orgId, table.valuationLayerId],
    foreignColumns: [invValuationLayers.orgId, invValuationLayers.id],
    name: "fk_inv_val_consumptions_org_layer",
  }),
]);

export const invAverageCostHistory = pgTable("inv_average_cost_history", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  stockTransactionId: integer("stock_transaction_id").notNull(),
  quantityBefore: decimal("quantity_before", { precision: 18, scale: 4 }).notNull(),
  averageBefore: decimal("average_before", { precision: 18, scale: 4 }),
  quantityIn: decimal("quantity_in", { precision: 18, scale: 4 }).notNull(),
  unitCostIn: decimal("unit_cost_in", { precision: 18, scale: 4 }).notNull(),
  averageAfter: decimal("average_after", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_avg_cost_history_txn").on(table.orgId, table.stockTransactionId),
  unique("uniq_inv_average_cost_history_org_id").on(table.orgId, table.id),
  index("idx_inv_avg_cost_history_org_variant").on(table.orgId, table.productVariantId, table.createdAt),
  foreignKey({
    columns: [table.orgId, table.stockTransactionId],
    foreignColumns: [invStockTransactions.orgId, invStockTransactions.id],
    name: "fk_inv_avg_cost_history_org_txn",
  }),
]);

export const invStandardCosts = pgTable("inv_standard_costs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_standard_costs_variant_from").on(table.orgId, table.productVariantId, table.effectiveFrom),
  unique("uniq_inv_standard_costs_org_id").on(table.orgId, table.id),
  index("idx_inv_standard_costs_lookup").on(table.orgId, table.productVariantId, table.effectiveFrom),
]);

export const invValuationLayersRelations = relations(invValuationLayers, ({ one, many }) => ({
  organization: one(organizations, { fields: [invValuationLayers.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invValuationLayers.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invValuationLayers.locationId], references: [invLocations.id] }),
  lot: one(invLots, { fields: [invValuationLayers.lotId], references: [invLots.id] }),
  consumptions: many(invValuationConsumptions),
}));

export const invValuationConsumptionsRelations = relations(invValuationConsumptions, ({ one }) => ({
  organization: one(organizations, { fields: [invValuationConsumptions.orgId], references: [organizations.id] }),
  layer: one(invValuationLayers, { fields: [invValuationConsumptions.valuationLayerId], references: [invValuationLayers.id] }),
  stockTransaction: one(invStockTransactions, { fields: [invValuationConsumptions.stockTransactionId], references: [invStockTransactions.id] }),
}));

export const invAverageCostHistoryRelations = relations(invAverageCostHistory, ({ one }) => ({
  organization: one(organizations, { fields: [invAverageCostHistory.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invAverageCostHistory.productVariantId], references: [invProductVariants.id] }),
}));

export const invStandardCostsRelations = relations(invStandardCosts, ({ one }) => ({
  organization: one(organizations, { fields: [invStandardCosts.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invStandardCosts.productVariantId], references: [invProductVariants.id] }),
  creator: one(users, { fields: [invStandardCosts.createdBy], references: [users.id] }),
}));
