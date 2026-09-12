import { pgTable, text, serial, timestamp, decimal, date, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invSoStatusEnum, invTaxTreatmentEnum, invGstModeEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { businessParties } from "../party/business-parties";
import { invoices } from "../crm/invoicing";
import { invProductVariants, invUom } from "./core";
import { invWarehouses } from "./warehouses";
import { invChannels } from "./channels";

export const invSalesOrders = pgTable("inv_sales_orders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id"),
  /**
  * The party this row belongs to. Ticket 08's expand.
  *
  * Beside `client_id` rather than replacing it: every existing reader keeps
  * working while readers move over one at a time, and the old column goes in
  * the contract migration once none is left. Nullable until then -- a null
  * means "not yet backfilled", which is a state worth being able to see.
  */
  clientPartyId: text("client_party_id"),
  soNumber: text("so_number").notNull(),
  status: invSoStatusEnum("status").default("DRAFT").notNull(),
  orderDate: date("order_date").notNull(),
  requiredDate: date("required_date"),
  shippingAddress: text("shipping_address"),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  /**
   * NEO-1 — the sales channel this order came from, or null for a direct sale.
   *
   * It is what lets a Blinkit order draw on the Blinkit pool while a storefront
   * order may not: availability is computed against every *other* channel's
   * claim, so an order that names its channel sees the units that channel is
   * holding and an order that does not, does not.
   */
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "set null" }),
  /**
   * NEO-3 — the platform purchase order this order fulfils.
   *
   * A real referential link rather than a join on dates and hope. Fill-rate is
   * "of what they ordered, how much did we ship", and without this the two
   * halves of that sentence are only guessable — which is how a fill-rate report
   * ends up being a number nobody trusts. Nullable, and declared as a bare
   * column because `quick-commerce.ts` imports this file; the constraint is
   * declared there.
   */
  platformPoId: integer("platform_po_id"),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  discount: decimal("discount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  notes: text("notes"),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at"),
  shippedAt: timestamp("shipped_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  /**
   * NO ACTION, deliberately — see 0662. The bare `SET NULL` this used to declare
   * nulls org_id as well on a composite key, which is NOT NULL, so the party
   * delete aborted. The party set takes NO ACTION rather than the column-list
   * form because it is the DPDP erasure path and that flow clears children
   * explicitly.
   */
  foreignKey({
    columns: [table.orgId, table.clientPartyId],
    foreignColumns: [businessParties.organizationId, businessParties.partyId],
    name: "fk_inv_sales_orders_client_party_id",
  }),
  uniqueIndex("uniq_inv_so_org_number").on(table.orgId, table.soNumber),
  unique("uniq_inv_sales_orders_org_id").on(table.orgId, table.id),
  index("idx_inv_so_org_status").on(table.orgId, table.status),
  index("idx_inv_so_client").on(table.clientId),
  index("idx_inv_so_warehouse").on(table.warehouseId),
  index("idx_inv_so_org_channel").on(table.orgId, table.channelId),
  index("idx_inv_so_org_platform_po").on(table.orgId, table.platformPoId),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_sales_orders_channel_id_org",
  }).onDelete("set null"),
]);

export const invSoLines = pgTable("inv_so_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityShipped: decimal("quantity_shipped", { precision: 18, scale: 4 }).default("0").notNull(),
  unitPrice: decimal("unit_price", { precision: 18, scale: 4 }).notNull(),
  uomId: integer("uom_id").references(() => invUom.id, { onDelete: "set null" }),
  quantityEntered: decimal("quantity_entered", { precision: 18, scale: 4 }),
  uomFactor: decimal("uom_factor", { precision: 18, scale: 6 }),
  /**
   * NEO-10 - how many physical units this line's weight is. Only meaningful for
   * a catch-weight SKU, where `quantity` is the weight and the price is per unit
   * of weight: two bags of chicken at 250 a kilo are 250 x 10.35, not 250 x 2,
   * and a system that cannot say that cannot invoice a butcher.
   */
  quantityPieces: decimal("quantity_pieces", { precision: 18, scale: 4 }),
  /**
   * The rate in percent, scale 2 — 18.00, not 0.18. `amount` beside it is the
   * taxable value (entered quantity × unit price) and is tax-exclusive.
   */
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  costAtTime: decimal("cost_at_time", { precision: 18, scale: 4 }).default("0").notNull(),
  /**
   * E2 — the tax inputs as they stood when this line was written. Same contract
   * as the purchase side: a snapshot rather than a join, nullable so that
   * "not recorded" stays distinguishable from "recorded as nil".
   */
  hsnCode: text("hsn_code"),
  taxTreatment: invTaxTreatmentEnum("tax_treatment"),
  gstMode: invGstModeEnum("gst_mode"),
  /** The exact tax on this line: `amount × taxRate / 100`, half-up at 4dp. */
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }),
  lineOrder: integer("line_order").default(0).notNull(),
}, (table) => [
  unique("uniq_inv_so_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.soId],
    foreignColumns: [invSalesOrders.orgId, invSalesOrders.id],
    name: "fk_inv_so_lines_so_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_so_lines_product_variant_id_org",
  }),
  index("idx_inv_so_lines_so").on(table.soId),
  index("idx_inv_so_lines_variant").on(table.productVariantId),
  // E2. A composition dealer may not collect tax from a customer, so an outward
  // line that snapshots COMPOSITION and still shows a rate is an invoice that
  // could not lawfully have been raised. The service refuses it with a legible
  // message; this is what makes it true against a direct write, and it is on the
  // sales table only — a composition dealer still *pays* tax on purchases.
  check(
    "chk_inv_so_lines_composition_no_outward_tax",
    sql`${table.gstMode} IS DISTINCT FROM 'COMPOSITION' OR (${table.taxRate} = 0 AND COALESCE(${table.taxAmount}, 0) = 0)`,
  ),
]);

export const invSalesOrdersRelations = relations(invSalesOrders, ({ one, many }) => ({
  organization: one(organizations, { fields: [invSalesOrders.orgId], references: [organizations.id] }),
  warehouse: one(invWarehouses, { fields: [invSalesOrders.warehouseId], references: [invWarehouses.id] }),
  channel: one(invChannels, { fields: [invSalesOrders.channelId], references: [invChannels.id] }),
  invoice: one(invoices, { fields: [invSalesOrders.invoiceId], references: [invoices.id] }),
  creator: one(users, { fields: [invSalesOrders.createdBy], references: [users.id] }),
  lines: many(invSoLines),
}));

export const invSoLinesRelations = relations(invSoLines, ({ one }) => ({
  salesOrder: one(invSalesOrders, { fields: [invSoLines.soId], references: [invSalesOrders.id] }),
  productVariant: one(invProductVariants, { fields: [invSoLines.productVariantId], references: [invProductVariants.id] }),
}));
