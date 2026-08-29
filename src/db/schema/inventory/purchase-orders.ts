import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, bigint, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invPoStatusEnum, invGrnQualityEnum, invGrnDiscrepancyEnum, invGrnStatusEnum, invTaxTreatmentEnum, invGstModeEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { clients } from "../crm/contacts";
import { businessParties } from "../party/business-parties";
import { invProductVariants, invUom } from "./core";
import { invLocations, invWarehouses } from "./warehouses";

export const invVendors = pgTable("inv_vendors", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  clientPartyId: text("client_party_id"),
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
  foreignKey({
    columns: [table.orgId, table.clientPartyId],
    foreignColumns: [businessParties.organizationId, businessParties.partyId],
    name: "fk_inv_vendors_client_party_id",
  }).onDelete("set null"),
  uniqueIndex("uniq_inv_vendors_org_code").on(table.orgId, table.code),
  unique("uniq_inv_vendors_org_id").on(table.orgId, table.id),
  index("idx_inv_vendors_org").on(table.orgId),
  index("idx_inv_vendors_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
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
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_po_org_number").on(table.orgId, table.poNumber),
  unique("uniq_inv_purchase_orders_org_id").on(table.orgId, table.id),
  index("idx_inv_po_org_status").on(table.orgId, table.status),
  index("idx_inv_po_vendor").on(table.vendorId),
  index("idx_inv_po_expected_delivery").on(table.expectedDeliveryDate),
]);

export const invPoLines = pgTable("inv_po_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).default("0").notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }).notNull(),
  uomId: integer("uom_id").references(() => invUom.id, { onDelete: "set null" }),
  quantityEntered: decimal("quantity_entered", { precision: 18, scale: 4 }),
  uomFactor: decimal("uom_factor", { precision: 18, scale: 6 }),
  /**
   * The rate in percent, scale 2 — 18.00, not 0.18. `amount` beside it is the
   * taxable value (entered quantity × unit cost) and is tax-exclusive; that was
   * already true before E2 and is stated here because the pair is now read by
   * something other than the header rollup.
   */
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  /**
   * E2 — the tax inputs as they stood when this line was written.
   *
   * A snapshot, not a join: reclassifying a SKU next quarter must not silently
   * restate what a purchase order already said, and the HSN code on a filed
   * return has to keep matching the document it came from. Nullable because
   * lines written before E2, and lines in organisations not running the `gst`
   * pack, have nothing to snapshot — and "we did not record this" must stay
   * distinguishable from "we recorded that it was nil".
   */
  hsnCode: text("hsn_code"),
  taxTreatment: invTaxTreatmentEnum("tax_treatment"),
  gstMode: invGstModeEnum("gst_mode"),
  /** The exact tax on this line: `amount × taxRate / 100`, half-up at 4dp. */
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }),
  lineOrder: integer("line_order").default(0).notNull(),
}, (table) => [
  unique("uniq_inv_po_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.poId],
    foreignColumns: [invPurchaseOrders.orgId, invPurchaseOrders.id],
    name: "fk_inv_po_lines_po_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_po_lines_product_variant_id_org",
  }),
  index("idx_inv_po_lines_po").on(table.poId),
  index("idx_inv_po_lines_variant").on(table.productVariantId),
]);

export const invGrns = pgTable("inv_grns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  poId: integer("po_id").references(() => invPurchaseOrders.id, { onDelete: "restrict" }).notNull(),
  grnNumber: text("grn_number").notNull(),
  receivedDate: date("received_date").notNull(),
  locationId: integer("location_id").references(() => invLocations.id, { onDelete: "set null" }),
  notes: text("notes"),
  /**
   * B1. Where this delivery is in its life. Nothing but POSTED has stock
   * behind it, so the status is the answer to "has this moved anything".
   */
  status: invGrnStatusEnum("status").default("DRAFT").notNull(),
  postedBy: text("posted_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_grn_org_number").on(table.orgId, table.grnNumber),
  unique("uniq_inv_grns_org_id").on(table.orgId, table.id),
  index("idx_inv_grn_po").on(table.poId),
  index("idx_inv_grn_org_status").on(table.orgId, table.status, table.receivedDate),
]);

export const invGrnLines = pgTable("inv_grn_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  grnId: integer("grn_id").references(() => invGrns.id, { onDelete: "cascade" }).notNull(),
  poLineId: integer("po_line_id").references(() => invPoLines.id, { onDelete: "restrict" }).notNull(),
  quantityReceived: decimal("quantity_received", { precision: 18, scale: 4 }).notNull(),
  uomId: integer("uom_id").references(() => invUom.id, { onDelete: "set null" }),
  quantityEntered: decimal("quantity_entered", { precision: 18, scale: 4 }),
  uomFactor: decimal("uom_factor", { precision: 18, scale: 6 }),
  qualityStatus: invGrnQualityEnum("quality_status").default("ACCEPTED").notNull(),
  rejectionReason: text("rejection_reason"),
  /**
   * INV-201. What the line still owed at the moment of receipt, snapshotted
   * for the same reason `uomFactor` is: a receipt has to stay readable after
   * the purchase order moves under it. Without it, "was this short?" can only
   * be answered by replaying every receipt against the line, and by then the
   * person who saw the pallet has gone home.
   */
  quantityExpected: decimal("quantity_expected", { precision: 18, scale: 4 }),
  /** NULL means the line matched, which is the common case. */
  discrepancyReason: invGrnDiscrepancyEnum("discrepancy_reason"),
  /**
   * B1. What the counter wrote down about the lot, held here until the receipt
   * posts.
   *
   * These used to go straight into `inv_lots` at receipt time, which is fine
   * when receiving and posting are the same act and wrong the moment they are
   * not: a draft that created lot rows would have put traceable batches into
   * the catalogue for goods nobody had accepted yet. The lot is resolved — found
   * or created — in the post transaction, from these three columns.
   */
  lotNumber: text("lot_number"),
  expiryDate: date("expiry_date"),
  manufactureDate: date("manufacture_date"),
  /**
   * E2 — the tax inputs as they stood when the goods were received.
   *
   * Taken again at receipt rather than read off the purchase order: months can
   * pass between ordering and receiving, and a reclassification in between
   * belongs to the receipt, which is the document the input credit is claimed
   * against. Once the GRN is POSTED these never change, whatever the catalogue
   * does afterwards.
   *
   * No `amount` here, because a GRN line prices nothing — it records a quantity
   * against a purchase-order line that already carries the price.
   */
  hsnCode: text("hsn_code"),
  taxTreatment: invTaxTreatmentEnum("tax_treatment"),
  gstMode: invGstModeEnum("gst_mode"),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }),
  /**
   * E3 — the two prices a pharmacy receipt has to capture, in integer paise.
   *
   * `mrpPaise` is what was printed on the cartons that arrived. Recorded here
   * and not read back off the catalogue, for the same reason the tax columns
   * above are snapshotted: the manufacturer reprints, and a receipt that says
   * what the SKU says *today* cannot answer "what were we allowed to sell this
   * batch for". The post transaction carries it onto `inv_lots.mrp_paise`,
   * which is what a dispense reads.
   *
   * `purchaseRatePaise` is what this delivery actually cost per unit, which is
   * routinely not what the purchase order said — trade schemes, revised rates
   * and free goods all land at the door rather than at the order. `inv_po_lines`
   * already carries the ordered rate; neither is derivable from the other, and
   * the difference between them is the whole margin conversation.
   *
   * Both nullable: lines written before E3 and organisations not running the
   * `pharmacy` pack have nothing to record, and null must keep meaning "not
   * recorded" rather than "free".
   */
  mrpPaise: bigint("mrp_paise", { mode: "number" }),
  purchaseRatePaise: bigint("purchase_rate_paise", { mode: "number" }),
}, (table) => [
  unique("uniq_inv_grn_lines_org_id").on(table.orgId, table.id),
  // E3. Zero is not a price; NULL is how "not recorded" is said.
  check("chk_inv_grn_lines_mrp_paise_positive", sql`${table.mrpPaise} IS NULL OR ${table.mrpPaise} > 0`),
  check(
    "chk_inv_grn_lines_purchase_rate_paise_positive",
    sql`${table.purchaseRatePaise} IS NULL OR ${table.purchaseRatePaise} > 0`,
  ),
  foreignKey({
    columns: [table.orgId, table.grnId],
    foreignColumns: [invGrns.orgId, invGrns.id],
    name: "fk_inv_grn_lines_grn_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.poLineId],
    foreignColumns: [invPoLines.orgId, invPoLines.id],
    name: "fk_inv_grn_lines_po_line_id_org",
  }),
  index("idx_inv_grn_lines_grn").on(table.grnId),
]);

/**
 * B1. The serials a counter scanned into a receipt line that has not posted.
 *
 * A row per serial rather than an array on the line, for the reason §3 gives:
 * an array cannot be indexed, cannot be appended to atomically by an operator
 * scanning one unit at a time, and cannot carry the uniqueness that matters
 * here — `uniq_inv_grn_line_serials_line_number` is what stops the same unit
 * being scanned twice into the same line, which no application check can
 * guarantee under two concurrent scanners.
 *
 * These are draft data, not stock: `inv_serial_numbers` rows are created in the
 * post transaction. A serial recorded here is a claim about what is on the
 * pallet; a serial there is a unit the business owns.
 */
export const invGrnLineSerials = pgTable("inv_grn_line_serials", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  grnLineId: integer("grn_line_id").references(() => invGrnLines.id, { onDelete: "cascade" }).notNull(),
  serialNumber: text("serial_number").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_grn_line_serials_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.grnLineId],
    foreignColumns: [invGrnLines.orgId, invGrnLines.id],
    name: "fk_inv_grn_line_serials_grn_line_id_org",
  }).onDelete("cascade"),
  uniqueIndex("uniq_inv_grn_line_serials_line_number").on(table.orgId, table.grnLineId, table.serialNumber),
  index("idx_inv_grn_line_serials_line").on(table.grnLineId),
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
  poster: one(users, { fields: [invGrns.postedBy], references: [users.id] }),
  lines: many(invGrnLines),
}));

export const invGrnLinesRelations = relations(invGrnLines, ({ one, many }) => ({
  grn: one(invGrns, { fields: [invGrnLines.grnId], references: [invGrns.id] }),
  poLine: one(invPoLines, { fields: [invGrnLines.poLineId], references: [invPoLines.id] }),
  serials: many(invGrnLineSerials),
}));

export const invGrnLineSerialsRelations = relations(invGrnLineSerials, ({ one }) => ({
  grnLine: one(invGrnLines, { fields: [invGrnLineSerials.grnLineId], references: [invGrnLines.id] }),
}));
