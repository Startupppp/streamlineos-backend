import { pgTable, text, serial, timestamp, decimal, integer, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../auth";
import { invProductVariants } from "./core";
import { invStockTransactions } from "./stock";

export const invValuationLayers = pgTable("inv_valuation_layers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
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
  index("idx_inv_val_layers_org_variant").on(table.orgId, table.productVariantId, table.createdAt),
  index("idx_inv_val_layers_remaining").on(table.orgId, table.productVariantId),
  index("idx_inv_val_layers_txn").on(table.stockTransactionId),
  index("idx_inv_val_layers_fifo").on(table.orgId, table.productVariantId, table.createdAt).where(sql`remaining_quantity > 0`),
]);

export const invValuationLayersRelations = relations(invValuationLayers, ({ one }) => ({
  organization: one(organizations, { fields: [invValuationLayers.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invValuationLayers.productVariantId], references: [invProductVariants.id] }),
}));
