import { pgTable, text, serial, timestamp, decimal, integer, boolean, date, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invShipmentStatusEnum, invPackageStatusEnum, invLoadStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";
import { invSalesOrders, invSoLines } from "./sales-orders";
import { invLots, invSerialNumbers } from "./traceability";
import { invStockTransfers } from "./stock";

export const invCarriers = pgTable("inv_carriers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  trackingUrlTemplate: text("tracking_url_template"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_carriers_org_code").on(table.orgId, table.code),
  unique("uniq_inv_carriers_org_id").on(table.orgId, table.id),
  index("idx_inv_carriers_org").on(table.orgId),
]);

export const invShipments = pgTable("inv_shipments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  shipmentNumber: text("shipment_number").notNull(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  carrierId: integer("carrier_id").references(() => invCarriers.id, { onDelete: "set null" }),
  trackingNumber: text("tracking_number"),
  status: invShipmentStatusEnum("status").default("DRAFT").notNull(),
  shippedAt: timestamp("shipped_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_shipments_org_number").on(table.orgId, table.shipmentNumber),
  unique("uniq_inv_shipments_org_id").on(table.orgId, table.id),
  index("idx_inv_shipments_org_status").on(table.orgId, table.status),
]);

export const invShipmentLines = pgTable("inv_shipment_lines", {
  id: serial("id").primaryKey(),
  shipmentId: integer("shipment_id").references(() => invShipments.id, { onDelete: "cascade" }).notNull(),
  soLineId: integer("so_line_id").references(() => invSoLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
}, (table) => [
  index("idx_inv_ship_lines_ship").on(table.shipmentId),
  index("idx_inv_shipment_lines_variant").on(table.productVariantId),
]);

export const invPackages = pgTable("inv_packages", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  packageNumber: text("package_number").notNull(),
  shipmentId: integer("shipment_id").references(() => invShipments.id, { onDelete: "set null" }),
  weight: decimal("weight", { precision: 18, scale: 4 }),
  dimensionsL: decimal("dimensions_l", { precision: 10, scale: 2 }),
  dimensionsW: decimal("dimensions_w", { precision: 10, scale: 2 }),
  dimensionsH: decimal("dimensions_h", { precision: 10, scale: 2 }),
  status: invPackageStatusEnum("status").default("OPEN").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_packages_org_number").on(table.orgId, table.packageNumber),
  unique("uniq_inv_packages_org_id").on(table.orgId, table.id),
  index("idx_inv_packages_org_status").on(table.orgId, table.status),
]);

export const invPackageLines = pgTable("inv_package_lines", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").references(() => invPackages.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
}, (table) => [
  index("idx_inv_pkg_lines_pkg").on(table.packageId),
  index("idx_inv_package_lines_variant").on(table.productVariantId),
]);

export const invLoads = pgTable("inv_loads", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  loadNumber: text("load_number").notNull(),
  sourceWarehouseId: integer("source_warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  destination: text("destination"),
  carrierId: integer("carrier_id").references(() => invCarriers.id, { onDelete: "set null" }),
  vehicleRef: text("vehicle_ref"),
  status: invLoadStatusEnum("status").default("DRAFT").notNull(),
  dispatchDate: date("dispatch_date"),
  arrivalDate: date("arrival_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_loads_org_number").on(table.orgId, table.loadNumber),
  unique("uniq_inv_loads_org_id").on(table.orgId, table.id),
  index("idx_inv_loads_org_status").on(table.orgId, table.status),
]);

export const invLoadLines = pgTable("inv_load_lines", {
  id: serial("id").primaryKey(),
  loadId: integer("load_id").references(() => invLoads.id, { onDelete: "cascade" }).notNull(),
  shipmentId: integer("shipment_id").references(() => invShipments.id, { onDelete: "set null" }),
  transferId: integer("transfer_id").references(() => invStockTransfers.id, { onDelete: "set null" }),
}, (table) => [
  index("idx_inv_load_lines_load").on(table.loadId),
]);

export const invCarriersRelations = relations(invCarriers, ({ one, many }) => ({
  organization: one(organizations, { fields: [invCarriers.orgId], references: [organizations.id] }),
  shipments: many(invShipments),
}));

export const invShipmentsRelations = relations(invShipments, ({ one, many }) => ({
  organization: one(organizations, { fields: [invShipments.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invShipments.warehouseId], references: [invWarehouses.id] }),
  carrier: one(invCarriers, { fields: [invShipments.carrierId], references: [invCarriers.id] }),
  creator: one(users, { fields: [invShipments.createdBy], references: [users.id], relationName: "shipCreator" }),
  lines: many(invShipmentLines),
}));

export const invShipmentLinesRelations = relations(invShipmentLines, ({ one }) => ({
  shipment: one(invShipments, { fields: [invShipmentLines.shipmentId], references: [invShipments.id] }),
  productVariant: one(invProductVariants, { fields: [invShipmentLines.productVariantId], references: [invProductVariants.id] }),
}));

export const invPackagesRelations = relations(invPackages, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPackages.orgId], references: [organizations.id] }),
  shipment: one(invShipments, { fields: [invPackages.shipmentId], references: [invShipments.id] }),
  creator: one(users, { fields: [invPackages.createdBy], references: [users.id] }),
  lines: many(invPackageLines),
}));

export const invPackageLinesRelations = relations(invPackageLines, ({ one }) => ({
  package: one(invPackages, { fields: [invPackageLines.packageId], references: [invPackages.id] }),
  productVariant: one(invProductVariants, { fields: [invPackageLines.productVariantId], references: [invProductVariants.id] }),
}));

export const invLoadsRelations = relations(invLoads, ({ one, many }) => ({
  organization: one(organizations, { fields: [invLoads.orgId], references: [organizations.id] }),
  sourceWarehouse: one(invWarehouses, { fields: [invLoads.sourceWarehouseId], references: [invWarehouses.id] }),
  carrier: one(invCarriers, { fields: [invLoads.carrierId], references: [invCarriers.id] }),
  creator: one(users, { fields: [invLoads.createdBy], references: [users.id] }),
  lines: many(invLoadLines),
}));

export const invLoadLinesRelations = relations(invLoadLines, ({ one }) => ({
  load: one(invLoads, { fields: [invLoadLines.loadId], references: [invLoads.id] }),
  shipment: one(invShipments, { fields: [invLoadLines.shipmentId], references: [invShipments.id] }),
}));
