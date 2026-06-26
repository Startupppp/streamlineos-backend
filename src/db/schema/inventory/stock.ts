import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invTxnTypeEnum, invAdjReasonEnum, invTransferStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { invProductVariants } from "./core";
import { invLocations } from "./warehouses";

export const invStockLevels = pgTable("inv_stock_levels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  onHand: decimal("on_hand", { precision: 18, scale: 4 }).default("0").notNull(),
  committed: decimal("committed", { precision: 18, scale: 4 }).default("0").notNull(),
  onOrder: decimal("on_order", { precision: 18, scale: 4 }).default("0").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_stock_variant_location").on(table.productVariantId, table.locationId),
  index("idx_inv_stock_org").on(table.orgId),
  index("idx_inv_stock_variant").on(table.productVariantId),
  index("idx_inv_stock_location").on(table.locationId),
]);

export const invStockTransactions = pgTable("inv_stock_transactions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  transactionType: invTxnTypeEnum("transaction_type").notNull(),
  quantityChange: decimal("quantity_change", { precision: 18, scale: 4 }).notNull(),
  quantityBefore: decimal("quantity_before", { precision: 18, scale: 4 }).notNull(),
  quantityAfter: decimal("quantity_after", { precision: 18, scale: 4 }).notNull(),
  referenceType: text("reference_type"),
  referenceId: text("reference_id"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_inv_txn_org_variant").on(table.orgId, table.productVariantId),
  index("idx_inv_txn_org_type").on(table.orgId, table.transactionType),
  index("idx_inv_txn_reference").on(table.referenceType, table.referenceId),
  index("idx_inv_txn_created").on(table.createdAt),
]);

export const invStockAdjustments = pgTable("inv_stock_adjustments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  referenceNumber: text("reference_number").notNull(),
  reason: invAdjReasonEnum("reason").notNull(),
  notes: text("notes"),
  status: text("status").default("POSTED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_adj_org_ref").on(table.orgId, table.referenceNumber),
  index("idx_inv_adj_org").on(table.orgId),
]);

export const invStockAdjustmentLines = pgTable("inv_stock_adjustment_lines", {
  id: serial("id").primaryKey(),
  adjustmentId: integer("adjustment_id").references(() => invStockAdjustments.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  quantityChange: decimal("quantity_change", { precision: 18, scale: 4 }).notNull(),
  notes: text("notes"),
}, (table) => [
  index("idx_inv_adj_lines_adj").on(table.adjustmentId),
]);

export const invStockTransfers = pgTable("inv_stock_transfers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  referenceNumber: text("reference_number").notNull(),
  fromLocationId: integer("from_location_id").references(() => invLocations.id, { onDelete: "restrict" }).notNull(),
  toLocationId: integer("to_location_id").references(() => invLocations.id, { onDelete: "restrict" }).notNull(),
  status: invTransferStatusEnum("status").default("PENDING").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_transfer_org_ref").on(table.orgId, table.referenceNumber),
  index("idx_inv_transfers_org_status").on(table.orgId, table.status),
]);

export const invStockTransferLines = pgTable("inv_stock_transfer_lines", {
  id: serial("id").primaryKey(),
  transferId: integer("transfer_id").references(() => invStockTransfers.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).default("0").notNull(),
  notes: text("notes"),
}, (table) => [
  index("idx_inv_transfer_lines_transfer").on(table.transferId),
]);

export const invStockLevelsRelations = relations(invStockLevels, ({ one }) => ({
  organization: one(organizations, { fields: [invStockLevels.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invStockLevels.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invStockLevels.locationId], references: [invLocations.id] }),
}));

export const invStockTransactionsRelations = relations(invStockTransactions, ({ one }) => ({
  organization: one(organizations, { fields: [invStockTransactions.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invStockTransactions.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invStockTransactions.locationId], references: [invLocations.id] }),
  creator: one(users, { fields: [invStockTransactions.createdBy], references: [users.id] }),
}));

export const invStockAdjustmentsRelations = relations(invStockAdjustments, ({ one, many }) => ({
  organization: one(organizations, { fields: [invStockAdjustments.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invStockAdjustments.createdBy], references: [users.id] }),
  lines: many(invStockAdjustmentLines),
}));

export const invStockAdjustmentLinesRelations = relations(invStockAdjustmentLines, ({ one }) => ({
  adjustment: one(invStockAdjustments, { fields: [invStockAdjustmentLines.adjustmentId], references: [invStockAdjustments.id] }),
  productVariant: one(invProductVariants, { fields: [invStockAdjustmentLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invStockAdjustmentLines.locationId], references: [invLocations.id] }),
}));

export const invStockTransfersRelations = relations(invStockTransfers, ({ one, many }) => ({
  organization: one(organizations, { fields: [invStockTransfers.orgId], references: [organizations.id] }),
  fromLocation: one(invLocations, { fields: [invStockTransfers.fromLocationId], references: [invLocations.id], relationName: "transferFrom" }),
  toLocation: one(invLocations, { fields: [invStockTransfers.toLocationId], references: [invLocations.id], relationName: "transferTo" }),
  creator: one(users, { fields: [invStockTransfers.createdBy], references: [users.id] }),
  lines: many(invStockTransferLines),
}));

export const invStockTransferLinesRelations = relations(invStockTransferLines, ({ one }) => ({
  transfer: one(invStockTransfers, { fields: [invStockTransferLines.transferId], references: [invStockTransfers.id] }),
  productVariant: one(invProductVariants, { fields: [invStockTransferLines.productVariantId], references: [invProductVariants.id] }),
}));
