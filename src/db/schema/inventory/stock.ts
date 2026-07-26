import { pgTable, text, serial, timestamp, decimal, integer, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invTxnTypeEnum, invAdjReasonEnum, invTransferStatusEnum, invAdjustmentStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invLots, invSerialNumbers } from "./traceability";

export const invStockLevels = pgTable("inv_stock_levels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "cascade" }).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "restrict" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "restrict" }),
  onHand: decimal("on_hand", { precision: 18, scale: 4 }).default("0").notNull(),
  committed: decimal("committed", { precision: 18, scale: 4 }).default("0").notNull(),
  onOrder: decimal("on_order", { precision: 18, scale: 4 }).default("0").notNull(),
  blockedQty: decimal("blocked_qty", { precision: 18, scale: 4 }).default("0"),
  qualityHoldQty: decimal("quality_hold_qty", { precision: 18, scale: 4 }).default("0"),
  outgoingQty: decimal("outgoing_qty", { precision: 18, scale: 4 }).default("0"),
  averageCost: decimal("average_cost", { precision: 18, scale: 4 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_inv_stock_org").on(table.orgId),
  index("idx_inv_stock_variant").on(table.productVariantId),
  index("idx_inv_stock_location").on(table.locationId),
  index("idx_inv_stock_lot").on(table.lotId),
  index("idx_inv_stock_serial").on(table.serialId),
  uniqueIndex("uniq_inv_stock_levels_natural_key").on(table.orgId, table.productVariantId, table.locationId, sql`coalesce(${table.lotId}, 0)`, sql`coalesce(${table.serialId}, 0)`),
  unique("uniq_inv_stock_levels_org_id").on(table.orgId, table.id),
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
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }),
  totalCost: decimal("total_cost", { precision: 18, scale: 4 }),
  idempotencyKey: text("idempotency_key"),
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  referenceType: text("reference_type"),
  referenceId: text("reference_id"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_inv_txn_org_variant").on(table.orgId, table.productVariantId),
  index("idx_inv_txn_org_type").on(table.orgId, table.transactionType),
  index("idx_inv_txn_reference").on(table.referenceType, table.referenceId),
  index("idx_inv_txn_idempotency").on(table.orgId, table.idempotencyKey),
  index("idx_inv_txn_created").on(table.createdAt),
  index("idx_inv_txn_org_created").on(table.orgId, table.createdAt),
  index("idx_inv_txn_org_variant_type_created").on(table.orgId, table.productVariantId, table.transactionType, table.createdAt),
  unique("uniq_inv_stock_transactions_org_id").on(table.orgId, table.id),
]);

export const invStockAdjustments = pgTable("inv_stock_adjustments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  referenceNumber: text("reference_number").notNull(),
  reason: invAdjReasonEnum("reason").notNull(),
  notes: text("notes"),
  status: invAdjustmentStatusEnum("status").default("POSTED").notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  postedBy: text("posted_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_inv_adj_org_ref").on(table.orgId, table.referenceNumber),
  unique("uniq_inv_stock_adjustments_org_id").on(table.orgId, table.id),
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
  index("idx_inv_stock_adjustment_lines_variant").on(table.productVariantId),
]);

export const invStockTransfers = pgTable("inv_stock_transfers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  referenceNumber: text("reference_number").notNull(),
  fromLocationId: integer("from_location_id").references(() => invLocations.id, { onDelete: "restrict" }).notNull(),
  toLocationId: integer("to_location_id").references(() => invLocations.id, { onDelete: "restrict" }).notNull(),
  fromWarehouseId: integer("from_warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }),
  toWarehouseId: integer("to_warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }),
  status: invTransferStatusEnum("status").default("PENDING").notNull(),
  notes: text("notes"),
  reservedAt: timestamp("reserved_at"),
  dispatchedAt: timestamp("dispatched_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_inv_transfer_org_ref").on(table.orgId, table.referenceNumber),
  unique("uniq_inv_stock_transfers_org_id").on(table.orgId, table.id),
  index("idx_inv_transfers_org_status").on(table.orgId, table.status),
]);

export const invStockTransferLines = pgTable("inv_stock_transfer_lines", {
  id: serial("id").primaryKey(),
  transferId: integer("transfer_id").references(() => invStockTransfers.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).default("0").notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "restrict" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "restrict" }),
  notes: text("notes"),
}, (table) => [
  index("idx_inv_transfer_lines_transfer").on(table.transferId),
  index("idx_inv_stock_transfer_lines_variant").on(table.productVariantId),
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
  approver: one(users, { fields: [invStockAdjustments.approvedBy], references: [users.id], relationName: "adjApprover" }),
  poster: one(users, { fields: [invStockAdjustments.postedBy], references: [users.id], relationName: "adjPoster" }),
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
  fromWarehouse: one(invWarehouses, { fields: [invStockTransfers.fromWarehouseId], references: [invWarehouses.id], relationName: "transferFromWh" }),
  toWarehouse: one(invWarehouses, { fields: [invStockTransfers.toWarehouseId], references: [invWarehouses.id], relationName: "transferToWh" }),
  creator: one(users, { fields: [invStockTransfers.createdBy], references: [users.id] }),
  lines: many(invStockTransferLines),
}));

export const invStockTransferLinesRelations = relations(invStockTransferLines, ({ one }) => ({
  transfer: one(invStockTransfers, { fields: [invStockTransferLines.transferId], references: [invStockTransfers.id] }),
  productVariant: one(invProductVariants, { fields: [invStockTransferLines.productVariantId], references: [invProductVariants.id] }),
  lot: one(invLots, { fields: [invStockTransferLines.lotId], references: [invLots.id] }),
  serial: one(invSerialNumbers, { fields: [invStockTransferLines.serialId], references: [invSerialNumbers.id] }),
}));
