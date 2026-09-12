import { pgTable, text, serial, timestamp, date, decimal, integer, bigint, jsonb, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  invQcProviderEnum,
  invPlatformPoStatusEnum,
  invAsnStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invLocations, invWarehouses } from "./warehouses";
import { invChannels } from "./channels";
import { invPurchaseOrders, invPoLines } from "./purchase-orders";

/**
 * NEO-2 — what a quick-commerce platform ordered from us.
 *
 * Blinkit, Instamart and Zepto each run their own dark-store WMS; a brand
 * selling into them is a **supplier**, not an operator of their warehouse. So
 * the document that crosses the boundary is a purchase order they raise on us,
 * and the answer is an advance shipping notice plus a delivery. Nothing here is
 * a stock movement, and this file imports no engine.
 *
 * The row is kept even when validation fails, and that is the point: a
 * rejected PO with the reason on each line is how an ops person finds out that
 * the platform's EAN for a SKU is not one we hold. Deleting it would leave them
 * with an error toast and no evidence.
 *
 * **Idempotency is the platform's own PO number**, unique per organisation and
 * provider. A retried delivery, a re-uploaded file and a re-parsed email all
 * land on the same row rather than making three purchase orders — which is the
 * failure mode of every file-drop integration that keys on nothing.
 *
 * `payloadDigest` rather than the payload: a platform PO carries store
 * addresses and contact names, and this table exists to answer "have we already
 * handled PO X", not to become a second copy of somebody's order book. Same
 * reasoning, and the same choice, as `inv_channel_webhook_deliveries` (E6).
 */
export const invPlatformPurchaseOrders = pgTable("inv_platform_purchase_orders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  provider: invQcProviderEnum("provider").notNull(),
  /** The platform's own identifier. The idempotency fence. */
  providerPoNumber: text("provider_po_number").notNull(),
  /**
   * The sales channel this platform is configured as, so an accepted PO can
   * reserve into that channel's pool (NEO-1). Nullable: a PO can be ingested
   * before anybody has wired the channel up, and refusing it then would lose the
   * document rather than the configuration gap.
   */
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  status: invPlatformPoStatusEnum("status").default("RECEIVED").notNull(),
  /** The platform's dark store / fulfilment node, as text — it is their id, not ours. */
  destinationRef: text("destination_ref"),
  orderedAt: timestamp("ordered_at"),
  expectedDeliveryDate: date("expected_delivery_date"),
  currency: text("currency").default("INR").notNull(),
  /** Set once the PO is accepted and a Streamline purchase order stands behind it. */
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "set null" }),
  /** Why the whole document was refused. Line-level reasons live on the lines. */
  rejectionReason: text("rejection_reason"),
  payloadDigest: text("payload_digest").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_platform_po_org_provider_number")
    .on(table.orgId, table.provider, table.providerPoNumber),
  unique("uniq_inv_platform_purchase_orders_org_id").on(table.orgId, table.id),
  index("idx_inv_platform_po_org_status").on(table.orgId, table.status, table.createdAt),
  index("idx_inv_platform_po_org_po").on(table.orgId, table.poId),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_platform_po_channel_org",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_platform_po_warehouse_org",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.poId],
    foreignColumns: [invPurchaseOrders.orgId, invPurchaseOrders.id],
    name: "fk_inv_platform_po_po_org",
  }).onDelete("set null"),
]);

/**
 * NEO-2 — one line of a platform purchase order, as the platform wrote it.
 *
 * The platform's own identifiers are kept verbatim (`providerSku`, `ean`,
 * `mrpPaise`, `packSize`) beside the variant we resolved them to. Storing only
 * the resolution would make a mis-mapping unfindable a week later, when the
 * question is "did they send us the wrong EAN or did we map it wrong".
 *
 * `productVariantId` is nullable and `validationError` is its explanation: an
 * unresolvable line does not stop the document being recorded, it stops the
 * document being accepted.
 */
export const invPlatformPoLines = pgTable("inv_platform_po_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  platformPoId: integer("platform_po_id").references(() => invPlatformPurchaseOrders.id, { onDelete: "cascade" }).notNull(),
  lineOrder: integer("line_order").default(0).notNull(),
  providerSku: text("provider_sku"),
  ean: text("ean"),
  /** Integer minor units. An MRP is a legal ceiling, not a rounding preference (E3). */
  mrpPaise: bigint("mrp_paise", { mode: "number" }),
  /** Units per case, as the platform states it. Validated against ours. */
  packSize: integer("pack_size"),
  quantityOrdered: decimal("quantity_ordered", { precision: 18, scale: 4 }).notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "set null" }),
  /** Null means the line resolved. Non-null names the field and what was wrong with it. */
  validationError: text("validation_error"),
}, (table) => [
  unique("uniq_inv_platform_po_lines_org_id").on(table.orgId, table.id),
  index("idx_inv_platform_po_lines_po").on(table.orgId, table.platformPoId),
  index("idx_inv_platform_po_lines_variant").on(table.orgId, table.productVariantId),
  foreignKey({
    columns: [table.orgId, table.platformPoId],
    foreignColumns: [invPlatformPurchaseOrders.orgId, invPlatformPurchaseOrders.id],
    name: "fk_inv_platform_po_lines_po_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_platform_po_lines_variant_org",
  }).onDelete("set null"),
  check("chk_inv_platform_po_lines_qty_positive", sql`${table.quantityOrdered} > 0`),
]);

/**
 * NEO-2 — an advance shipping notice: what we said we would send, before it
 * arrives.
 *
 * An ASN is the document a receiving dock plans against. It is not a receipt and
 * it moves no stock — `inv_grns` remains the only thing a post runs from, and a
 * GRN now names the ASN it fulfils rather than the two being related by date and
 * hope.
 *
 * The appointment window lives here as two timestamps. NEO-12's dock
 * appointments add doors and collision detection on top; this is the field the
 * receiving policy reads when it asks "was this expected".
 */
export const invAsns = pgTable("inv_asns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  asnNumber: text("asn_number").notNull(),
  /** The platform PO this shipment answers, when there is one. */
  platformPoId: integer("platform_po_id").references(() => invPlatformPurchaseOrders.id, { onDelete: "set null" }),
  /** The Streamline purchase order the goods are received against. */
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "restrict" }).notNull(),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  status: invAsnStatusEnum("status").default("DRAFT").notNull(),
  carrierName: text("carrier_name"),
  trackingRef: text("tracking_ref"),
  appointmentStart: timestamp("appointment_start"),
  appointmentEnd: timestamp("appointment_end"),
  expectedArrival: date("expected_arrival"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_asns_org_number").on(table.orgId, table.asnNumber),
  unique("uniq_inv_asns_org_id").on(table.orgId, table.id),
  index("idx_inv_asns_org_status").on(table.orgId, table.status, table.expectedArrival),
  index("idx_inv_asns_org_po").on(table.orgId, table.poId),
  foreignKey({
    columns: [table.orgId, table.poId],
    foreignColumns: [invPurchaseOrders.orgId, invPurchaseOrders.id],
    name: "fk_inv_asns_po_org",
  }),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_asns_warehouse_org",
  }).onDelete("set null"),
  // An appointment that ends before it starts is not a window, and a window
  // nobody can keep is worse than none.
  check(
    "chk_inv_asns_appointment_window",
    sql`${table.appointmentStart} IS NULL OR ${table.appointmentEnd} IS NULL OR ${table.appointmentEnd} > ${table.appointmentStart}`,
  ),
]);

export const invAsnLines = pgTable("inv_asn_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  asnId: integer("asn_id").references(() => invAsns.id, { onDelete: "cascade" }).notNull(),
  poLineId: integer("po_line_id").references(() => invPoLines.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantityExpected: decimal("quantity_expected", { precision: 18, scale: 4 }).notNull(),
  lotNumber: text("lot_number"),
  expiryDate: date("expiry_date"),
  mrpPaise: bigint("mrp_paise", { mode: "number" }),
  lineOrder: integer("line_order").default(0).notNull(),
}, (table) => [
  unique("uniq_inv_asn_lines_org_id").on(table.orgId, table.id),
  index("idx_inv_asn_lines_asn").on(table.orgId, table.asnId),
  foreignKey({
    columns: [table.orgId, table.asnId],
    foreignColumns: [invAsns.orgId, invAsns.id],
    name: "fk_inv_asn_lines_asn_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_asn_lines_variant_org",
  }),
  check("chk_inv_asn_lines_qty_positive", sql`${table.quantityExpected} > 0`),
]);

/**
 * NEO-3 — what the platform says it paid us, line by line.
 *
 * A payout file is the platform's own accounting of a delivery: how many units
 * it accepted, at what rate, against which of its purchase orders. It is
 * uploaded, never fetched — there is no connected account (see
 * `quick-commerce-inbound.ts`) — and it is **not** a bank statement and **not**
 * a general-ledger entry. Nothing in this table posts to accounting, and the
 * reconciliation report says so on its face.
 *
 * The row is kept whether or not it matched. An unmatched payout line is the
 * entire point of the exercise: it is the platform paying for something we have
 * no record of shipping, or paying nothing for something we did — and a matcher
 * that silently dropped what it could not place would hide exactly the lines
 * somebody has to chase.
 *
 * `amountPaise` is integer minor units. A payout is money.
 */
export const invPlatformPayoutLines = pgTable("inv_platform_payout_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  provider: invQcProviderEnum("provider").notNull(),
  /** The platform's own payout/settlement reference, as printed on their file. */
  payoutRef: text("payout_ref").notNull(),
  providerPoNumber: text("provider_po_number"),
  providerSku: text("provider_sku"),
  ean: text("ean"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  settledOn: date("settled_on"),
  /** The platform PO line this was matched to, or null when nothing fitted. */
  platformPoLineId: integer("platform_po_line_id").references(() => invPlatformPoLines.id, { onDelete: "set null" }),
  /** Why it did not match. Null once it has. */
  unmatchedReason: text("unmatched_reason"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_platform_payout_lines_org_id").on(table.orgId, table.id),
  // The fence: one payout reference plus one line key is one settlement line, so
  // re-uploading the same file is a no-op rather than a doubled payout.
  uniqueIndex("uniq_inv_platform_payout_line_key").on(
    table.orgId,
    table.provider,
    table.payoutRef,
    sql`coalesce(${table.providerPoNumber}, '')`,
    sql`coalesce(${table.providerSku}, ${table.ean}, '')`,
  ),
  index("idx_inv_platform_payout_org_provider_po")
    .on(table.orgId, table.provider, table.providerPoNumber),
  index("idx_inv_platform_payout_org_unmatched")
    .on(table.orgId, table.createdAt)
    .where(sql`${table.platformPoLineId} IS NULL`),
  foreignKey({
    columns: [table.orgId, table.platformPoLineId],
    foreignColumns: [invPlatformPoLines.orgId, invPlatformPoLines.id],
    name: "fk_inv_platform_payout_line_org",
  }).onDelete("set null"),
  check("chk_inv_platform_payout_lines_qty_positive", sql`${table.quantity} > 0`),
]);

export const invPlatformPurchaseOrdersRelations = relations(invPlatformPurchaseOrders, ({ one, many }) => ({
  organization: one(organizations, { fields: [invPlatformPurchaseOrders.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invPlatformPurchaseOrders.channelId], references: [invChannels.id] }),
  warehouse: one(invWarehouses, { fields: [invPlatformPurchaseOrders.warehouseId], references: [invWarehouses.id] }),
  purchaseOrder: one(invPurchaseOrders, { fields: [invPlatformPurchaseOrders.poId], references: [invPurchaseOrders.id] }),
  lines: many(invPlatformPoLines),
}));

export const invPlatformPoLinesRelations = relations(invPlatformPoLines, ({ one }) => ({
  platformPurchaseOrder: one(invPlatformPurchaseOrders, {
    fields: [invPlatformPoLines.platformPoId],
    references: [invPlatformPurchaseOrders.id],
  }),
  productVariant: one(invProductVariants, {
    fields: [invPlatformPoLines.productVariantId],
    references: [invProductVariants.id],
  }),
}));

export const invAsnsRelations = relations(invAsns, ({ one, many }) => ({
  organization: one(organizations, { fields: [invAsns.orgId], references: [organizations.id] }),
  purchaseOrder: one(invPurchaseOrders, { fields: [invAsns.poId], references: [invPurchaseOrders.id] }),
  warehouse: one(invWarehouses, { fields: [invAsns.warehouseId], references: [invWarehouses.id] }),
  platformPurchaseOrder: one(invPlatformPurchaseOrders, {
    fields: [invAsns.platformPoId],
    references: [invPlatformPurchaseOrders.id],
  }),
  lines: many(invAsnLines),
}));

export const invAsnLinesRelations = relations(invAsnLines, ({ one }) => ({
  asn: one(invAsns, { fields: [invAsnLines.asnId], references: [invAsns.id] }),
  productVariant: one(invProductVariants, { fields: [invAsnLines.productVariantId], references: [invProductVariants.id] }),
}));

/**
 * There is deliberately no Drizzle `relations()` entry for `inv_grns.asn_id`.
 *
 * `quick-commerce.ts` imports `purchase-orders.ts`, so an `asn` relation on
 * `invGrnsRelations` would need the import back and a second `relations(invGrns,
 * …)` here would silently contend with the first. The GRN read joins
 * `inv_asns` explicitly instead, which is one line and cannot be ambiguous.
 */
