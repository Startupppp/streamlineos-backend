import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invPoStatusEnum, invGrnQualityEnum } from "../enums";
import { organizations, users } from "../auth";
import { clients } from "../crm/contacts";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";

export const invVendors = pgTable("inv_vendors", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  code: text("code").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  gstin: text("gstin"),
  leadTimeDays: integer("lead_time_days").default(7).notNull(),
  paymentTermsDays: integer("payment_terms_days").default(30).notNull(),
  currency: text("currency").default("INR").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_vendors_org_code").on(table.orgId, table.code),
  index("idx_inv_vendors_org").on(table.orgId),
]);

export const invPurchaseOrders = pgTable("inv_purchase_orders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  vendorId: integer("vendor_id").references(() => invVendors.id, { onDelete: "restrict" }).notNull(),
  poNumber: text("po_number").notNull(),
  status: invPoStatusEnum("status").default("DRAFT").notNull(),
  orderDate: date("order_date").notNull(),
  expectedDeliveryDate: date("expected_delivery_date"),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  discount: decimal("discount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  notes: text("notes"),
  sentAt: timestamp("sent_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_po_org_number").on(table.orgId, table.poNumber),
  index("idx_inv_po_org_status").on(table.orgId, table.status),
  index("idx_inv_po_vendor").on(table.vendorId),
  index("idx_inv_po_expected_delivery").on(table.expectedDeliveryDate),
]);

export const invPoLines = pgTable("inv_po_lines", {
  id: serial("id").primaryKey(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).default("0").notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }).notNull(),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").default(0).notNull(),
}, (table) => [
  index("idx_inv_po_lines_po").on(table.poId),
]);

export const invGrns = pgTable("inv_grns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "restrict" }).notNull(),
  grnNumber: text("grn_number").notNull(),
  receivedDate: date("received_date").notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_grn_org_number").on(table.orgId, table.grnNumber),
  index("idx_inv_grn_po").on(table.poId),
]);

export const invGrnLines = pgTable("inv_grn_lines", {
  id: serial("id").primaryKey(),
  grnId: integer("grn_id").references(() => invGrns.id, { onDelete: "cascade" }).notNull(),
  poLineId: integer("po_line_id").references(() => invPoLines.id, { onDelete: "restrict" }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).notNull(),
  qualityStatus: invGrnQualityEnum("quality_status").default("ACCEPTED").notNull(),
  rejectionReason: text("rejection_reason"),
}, (table) => [
  index("idx_inv_grn_lines_grn").on(table.grnId),
]);

export const invVendorsRelations = relations(invVendors, ({ one, many }) => ({
  organization: one(organizations, { fields: [invVendors.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [invVendors.clientId], references: [clients.id] }),
  creator: one(users, { fields: [invVendors.createdBy], references: [users.id] }),
  purchaseOrders: many(invPurchaseOrders),
}));

export const invPurchaseOrdersRelations = relations(invPurchaseOrders, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPurchaseOrders.orgId], references: [organizations.id] }),
  vendor: one(invVendors, { fields: [invPurchaseOrders.vendorId], references: [invVendors.id] }),
  warehouse: one(invWarehouses, { fields: [invPurchaseOrders.warehouseId], references: [invWarehouses.id] }),
  creator: one(users, { fields: [invPurchaseOrders.createdBy], references: [users.id] }),
  lines: many(invPoLines),
  grns: many(invGrns),
}));

export const invPoLinesRelations = relations(invPoLines, ({ one }) => ({
  purchaseOrder: one(invPurchaseOrders, { fields: [invPoLines.poId], references: [invPurchaseOrders.id] }),
  productVariant: one(invProductVariants, { fields: [invPoLines.productVariantId], references: [invProductVariants.id] }),
}));

export const invGrnsRelations = relations(invGrns, ({ one, many }) => ({
  organization: one(organizations, { fields: [invGrns.orgId], references: [organizations.id] }),
  purchaseOrder: one(invPurchaseOrders, { fields: [invGrns.poId], references: [invPurchaseOrders.id] }),
  location: one(invLocations, { fields: [invGrns.locationId], references: [invLocations.id] }),
  creator: one(users, { fields: [invGrns.createdBy], references: [users.id] }),
  lines: many(invGrnLines),
}));

export const invGrnLinesRelations = relations(invGrnLines, ({ one }) => ({
  grn: one(invGrns, { fields: [invGrnLines.grnId], references: [invGrns.id] }),
  poLine: one(invPoLines, { fields: [invGrnLines.poLineId], references: [invPoLines.id] }),
}));
