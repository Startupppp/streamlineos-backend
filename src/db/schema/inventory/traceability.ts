import { pgTable, text, serial, timestamp, date, jsonb, integer, bigint, index, uniqueIndex, unique, check } from "drizzle-orm/pg-core";
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
  /**
   * E3 — the maximum retail price printed on the packs in *this* batch, in
   * integer paise.
   *
   * This is the snapshot, and `inv_products.mrp_paise` is not. The catalogue
   * column is the SKU's current printed price and moves when the manufacturer
   * reprints; this one is a fact about a physical batch and is written once, in
   * the receipt's post transaction, from what the counter read off the carton.
   * It is never updated afterwards, because the ceiling that binds a sale is the
   * one printed on the pack the customer is handed — two batches of the same
   * medicine standing side by side on the same shelf routinely carry different
   * MRPs, and the older one may not be sold at the newer one's price.
   *
   * Nullable, and stays null for every batch received before E3, in
   * organisations not running the `pharmacy` pack, and for goods with no printed
   * price. "Not recorded" has to stay distinguishable from "recorded as zero".
   */
  mrpPaise: bigint("mrp_paise", { mode: "number" }),
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
  // E3. A ceiling of zero is not a ceiling; NULL already says "not recorded".
  check("chk_inv_lots_mrp_paise_positive", sql`${table.mrpPaise} IS NULL OR ${table.mrpPaise} > 0`),
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
