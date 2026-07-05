import { pgTable, text, serial, timestamp, decimal, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invReservationStatusEnum } from "../enums";
import { organizations } from "../auth";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";

export const invStockReservations = pgTable("inv_stock_reservations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceLineId: text("source_line_id"),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  lotId: integer("lot_id"),
  serialId: integer("serial_id"),
  reservedQty: decimal("reserved_qty", { precision: 18, scale: 4 }).notNull(),
  status: invReservationStatusEnum("status").default("ACTIVE").notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_inv_res_org_source").on(table.orgId, table.sourceType, table.sourceId),
  index("idx_inv_res_org_variant_status").on(table.orgId, table.productVariantId, table.status),
  index("idx_inv_res_org_status").on(table.orgId, table.status),
]);

export const invStockReservationsRelations = relations(invStockReservations, ({ one }) => ({
  organization: one(organizations, { fields: [invStockReservations.orgId], references: [organizations.id] }),
  productVariant: one(invProductVariants, { fields: [invStockReservations.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invStockReservations.warehouseId], references: [invWarehouses.id] }),
  location: one(invLocations, { fields: [invStockReservations.locationId], references: [invLocations.id] }),
}));
