import { pgTable, text, serial, timestamp, date, jsonb, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invLotStatusEnum, invSerialStatusEnum } from "../common/enums";
import { organizations } from "../common/auth";
import { invProductVariants } from "./core";
import { invLocations } from "./warehouses";

export const invLots = pgTable("inv_lots", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  lotNumber: text("lot_number").notNull(),
  manufactureDate: date("manufacture_date"),
  expiryDate: date("expiry_date"),
  supplierLotNumber: text("supplier_lot_number"),
  status: invLotStatusEnum("status").default("ACTIVE").notNull(),
  qualityStatus: text("quality_status"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_lots_org_variant_number").on(table.orgId, table.productVariantId, table.lotNumber),
  unique("uniq_inv_lots_org_id").on(table.orgId, table.id),
  index("idx_inv_lots_org").on(table.orgId),
  index("idx_inv_lots_variant").on(table.productVariantId),
  index("idx_inv_lots_expiry").on(table.expiryDate),
  index("idx_inv_lots_status").on(table.orgId, table.status),
  index("idx_inv_lots_lot_number_trgm").using("gin", table.lotNumber.op("gin_trgm_ops")),
]);

export const invSerialNumbers = pgTable("inv_serial_numbers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  serialNumber: text("serial_number").notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  status: invSerialStatusEnum("status").default("IN_STOCK").notNull(),
  currentLocationId: integer("current_location_id").references(() => invLocations.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_serials_org_variant_number").on(table.orgId, table.productVariantId, table.serialNumber),
  unique("uniq_inv_serial_numbers_org_id").on(table.orgId, table.id),
  index("idx_inv_serials_org").on(table.orgId),
  index("idx_inv_serials_variant").on(table.productVariantId),
  index("idx_inv_serials_status").on(table.orgId, table.status),
  index("idx_inv_serials_location").on(table.currentLocationId),
  // D1. `lot_id` is the one real parent/child FK in this schema and had no
  // index, so walking from a lot to the units it contains scanned every serial
  // in the tenant. Added in 0542.
  index("idx_inv_serials_org_lot").on(table.orgId, table.lotId).where(sql`${table.lotId} IS NOT NULL`),
  index("idx_inv_serials_serial_number_trgm").using("gin", table.serialNumber.op("gin_trgm_ops")),
]);

export const invLotsRelations = relations(invLots, ({ one }) => ({
  organization: one(organizations, { fields: [invLots.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invLots.productVariantId], references: [invProductVariants.id] }),
}));

export const invSerialNumbersRelations = relations(invSerialNumbers, ({ one }) => ({
  organization: one(organizations, { fields: [invSerialNumbers.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invSerialNumbers.productVariantId], references: [invProductVariants.id] }),
  currentLocation: one(invLocations, { fields: [invSerialNumbers.currentLocationId], references: [invLocations.id] }),
}));
