import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invVendorReturnReasonEnum, invCustomerReturnDispositionEnum,
  invPickListStatusEnum, invCycleCountStatusEnum,
  invReturnStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants, invCategories } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invVendors, invPurchaseOrders, invGrns } from "./purchase-orders";
import { invSalesOrders, invSoLines } from "./sales-orders";
import { invShipments } from "./shipping";
import { invLots, invSerialNumbers } from "./traceability";

export const invVendorReturns = pgTable("inv_vendor_returns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  returnNumber: text("return_number").notNull(),
  vendorId: integer("vendor_id").references(() => invVendors.id, { onDelete: "restrict" }).notNull(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "set null" }),
  grnId: integer("grn_id").references(() => invGrns.id, { onDelete: "set null" }),
  status: invReturnStatusEnum("status").default("DRAFT").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_vret_org_number").on(table.orgId, table.returnNumber),
  unique("uniq_inv_vendor_returns_org_id").on(table.orgId, table.id),
  index("idx_inv_vret_org_status").on(table.orgId, table.status),
]);

export const invVendorReturnLines = pgTable("inv_vendor_return_lines", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").references(() => invVendorReturns.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  reason: invVendorReturnReasonEnum("reason").notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }),
}, (table) => [
  index("idx_inv_vret_lines_return").on(table.returnId),
  index("idx_inv_vendor_return_lines_variant").on(table.productVariantId),
]);

export const invCustomerReturns = pgTable("inv_customer_returns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  returnNumber: text("return_number").notNull(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "set null" }),
  shipmentId: integer("shipment_id").references(() => invShipments.id, { onDelete: "set null" }),
  clientId: integer("client_id"),
  /**
   * The party this return's customer is. Ticket 08's expand.
   *
   * Note what `client_id` above does NOT have: a foreign key in the database.
   * Drizzle declares one and no migration ever created it, so this column was
   * missing from the catalogue-derived list of blockers and was found by the
   * schema invariant instead.
   */
  clientPartyId: text("client_party_id"),
  status: invReturnStatusEnum("status").default("DRAFT").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_cret_org_number").on(table.orgId, table.returnNumber),
  unique("uniq_inv_customer_returns_org_id").on(table.orgId, table.id),
  index("idx_inv_cret_org_status").on(table.orgId, table.status),
]);

export const invCustomerReturnLines = pgTable("inv_customer_return_lines", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").references(() => invCustomerReturns.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  disposition: invCustomerReturnDispositionEnum("disposition"),
  notes: text("notes"),
}, (table) => [
  index("idx_inv_cret_lines_return").on(table.returnId),
  index("idx_inv_customer_return_lines_variant").on(table.productVariantId),
]);

export const invPickLists = pgTable("inv_pick_lists", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pickNumber: text("pick_number").notNull(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }),
  status: invPickListStatusEnum("status").default("PENDING").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_pick_org_number").on(table.orgId, table.pickNumber),
  unique("uniq_inv_pick_lists_org_id").on(table.orgId, table.id),
  index("idx_inv_pick_org_status").on(table.orgId, table.status),
]);

export const invPickListLines = pgTable("inv_pick_list_lines", {
  id: serial("id").primaryKey(),
  pickListId: integer("pick_list_id").references(() => invPickLists.id, { onDelete: "cascade" }).notNull(),
  soLineId: integer("so_line_id").references(() => invSoLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantityToPick: decimal("quantity_to_pick", { precision: 18, scale: 4 }).notNull(),
  quantityPicked: decimal("quantity_picked", { precision: 18, scale: 4 }).default("0").notNull(),
}, (table) => [
  index("idx_inv_pick_lines_pick").on(table.pickListId),
  index("idx_inv_pick_list_lines_variant").on(table.productVariantId),
]);

export const invCycleCounts = pgTable("inv_cycle_counts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  countNumber: text("count_number").notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }).notNull(),
  locationId: integer("location_id").references(() => invLocations.id),
  categoryId: integer("category_id").references(() => invCategories.id, { onDelete: "set null" }),
  status: invCycleCountStatusEnum("status").default("PLANNED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_cc_org_number").on(table.orgId, table.countNumber),
  unique("uniq_inv_cycle_counts_org_id").on(table.orgId, table.id),
  index("idx_inv_cc_org_status").on(table.orgId, table.status),
]);

export const invCycleCountLines = pgTable("inv_cycle_count_lines", {
  id: serial("id").primaryKey(),
  cycleCountId: integer("cycle_count_id").references(() => invCycleCounts.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  systemQty: decimal("system_qty", { precision: 18, scale: 4 }).notNull(),
  countedQty: decimal("counted_qty", { precision: 18, scale: 4 }),
  varianceQty: decimal("variance_qty", { precision: 18, scale: 4 }),
}, (table) => [
  index("idx_inv_cc_lines_count").on(table.cycleCountId),
  index("idx_inv_cycle_count_lines_variant").on(table.productVariantId),
]);

export const invPhysicalAudits = pgTable("inv_physical_audits", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  auditNumber: text("audit_number").notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "restrict" }).notNull(),
  status: invCycleCountStatusEnum("status").default("PLANNED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_pa_org_number").on(table.orgId, table.auditNumber),
  unique("uniq_inv_physical_audits_org_id").on(table.orgId, table.id),
  index("idx_inv_pa_org_status").on(table.orgId, table.status),
]);

export const invPhysicalAuditLines = pgTable("inv_physical_audit_lines", {
  id: serial("id").primaryKey(),
  auditId: integer("audit_id").references(() => invPhysicalAudits.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  locationId: integer("location_id").references(() => invLocations.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  systemQty: decimal("system_qty", { precision: 18, scale: 4 }).notNull(),
  countedQty: decimal("counted_qty", { precision: 18, scale: 4 }),
  varianceQty: decimal("variance_qty", { precision: 18, scale: 4 }),
}, (table) => [
  index("idx_inv_pa_lines_audit").on(table.auditId),
  index("idx_inv_physical_audit_lines_variant").on(table.productVariantId),
]);

export const invVendorReturnsRelations = relations(invVendorReturns, ({ one, many }) => ({
  organization: one(organizations, { fields: [invVendorReturns.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invVendorReturns.createdBy], references: [users.id], relationName: "vretCreator" }),
  approver: one(users, { fields: [invVendorReturns.approvedBy], references: [users.id], relationName: "vretApprover" }),
  lines: many(invVendorReturnLines),
}));

export const invVendorReturnLinesRelations = relations(invVendorReturnLines, ({ one }) => ({
  vendorReturn: one(invVendorReturns, { fields: [invVendorReturnLines.returnId], references: [invVendorReturns.id] }),
  productVariant: one(invProductVariants, { fields: [invVendorReturnLines.productVariantId], references: [invProductVariants.id] }),
}));

export const invCustomerReturnsRelations = relations(invCustomerReturns, ({ one, many }) => ({
  organization: one(organizations, { fields: [invCustomerReturns.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invCustomerReturns.createdBy], references: [users.id], relationName: "cretCreator" }),
  approver: one(users, { fields: [invCustomerReturns.approvedBy], references: [users.id], relationName: "cretApprover" }),
  lines: many(invCustomerReturnLines),
}));

export const invCustomerReturnLinesRelations = relations(invCustomerReturnLines, ({ one }) => ({
  customerReturn: one(invCustomerReturns, { fields: [invCustomerReturnLines.returnId], references: [invCustomerReturns.id] }),
  productVariant: one(invProductVariants, { fields: [invCustomerReturnLines.productVariantId], references: [invProductVariants.id] }),
}));

export const invPickListsRelations = relations(invPickLists, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPickLists.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invPickLists.createdBy], references: [users.id] }),
  lines: many(invPickListLines),
}));

export const invPickListLinesRelations = relations(invPickListLines, ({ one }) => ({
  pickList: one(invPickLists, { fields: [invPickListLines.pickListId], references: [invPickLists.id] }),
  productVariant: one(invProductVariants, { fields: [invPickListLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invPickListLines.locationId], references: [invLocations.id] }),
}));

export const invCycleCountsRelations = relations(invCycleCounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [invCycleCounts.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invCycleCounts.createdBy], references: [users.id], relationName: "ccCreator" }),
  approver: one(users, { fields: [invCycleCounts.approvedBy], references: [users.id], relationName: "ccApprover" }),
  lines: many(invCycleCountLines),
}));

export const invCycleCountLinesRelations = relations(invCycleCountLines, ({ one }) => ({
  cycleCount: one(invCycleCounts, { fields: [invCycleCountLines.cycleCountId], references: [invCycleCounts.id] }),
  productVariant: one(invProductVariants, { fields: [invCycleCountLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invCycleCountLines.locationId], references: [invLocations.id] }),
}));

export const invPhysicalAuditsRelations = relations(invPhysicalAudits, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPhysicalAudits.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invPhysicalAudits.createdBy], references: [users.id], relationName: "paCreator" }),
  approver: one(users, { fields: [invPhysicalAudits.approvedBy], references: [users.id], relationName: "paApprover" }),
  lines: many(invPhysicalAuditLines),
}));

export const invPhysicalAuditLinesRelations = relations(invPhysicalAuditLines, ({ one }) => ({
  audit: one(invPhysicalAudits, { fields: [invPhysicalAuditLines.auditId], references: [invPhysicalAudits.id] }),
  productVariant: one(invProductVariants, { fields: [invPhysicalAuditLines.productVariantId], references: [invProductVariants.id] }),
  location: one(invLocations, { fields: [invPhysicalAuditLines.locationId], references: [invLocations.id] }),
}));
