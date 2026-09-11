/**
 * Goods coming back, in both directions.
 *
 * A vendor return sends rejected stock back up the supply chain against a
 * purchase order or a GRN; a customer return brings sold stock back down against
 * a sales order or a shipment, and carries a disposition per line because where
 * the units go — restock, quarantine, scrap, or on to the vendor — is the whole
 * decision. Header and lines stay together with their relations.
 *
 * Moved verbatim out of `operations.ts`, which was three unrelated subjects in
 * one file; see also `./picking` and `./counting`.
 */

import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invVendorReturnReasonEnum, invCustomerReturnDispositionEnum, invReturnStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { businessParties } from "../party/business-parties";
import { invProductVariants } from "./core";
import { invLocations } from "./warehouses";
import { invVendors, invPurchaseOrders, invGrns } from "./purchase-orders";
import { invSalesOrders } from "./sales-orders";
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
  createdByMembershipId: integer("created_by_membership_id"),
  approvedBy: text("approved_by").references(() => users.id),
  /**
   * B9. When the approval happened, beside who gave it. `approvedBy` was
   * previously stamped by `post`, which made it a second name for "posted by"
   * and left the approval itself unrecorded.
   */
  approvedAt: timestamp("approved_at"),
  /**
   * B9, item 5. The vendor credit note this return expects, as an opaque
   * reference into whatever system issued it. It is a pointer, not a
   * transaction: nothing here reads it, and posting the stock never waits on
   * it.
   */
  creditReference: text("credit_reference"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_vret_org_number").on(table.orgId, table.returnNumber),
  unique("uniq_inv_vendor_returns_org_id").on(table.orgId, table.id),
  index("idx_inv_vret_org_status").on(table.orgId, table.status),
  index("idx_inv_vret_org_grn").on(table.orgId, table.grnId),
]);

export const invVendorReturnLines = pgTable("inv_vendor_return_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  returnId: integer("return_id").references(() => invVendorReturns.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  reason: invVendorReturnReasonEnum("reason").notNull(),
  unitCost: decimal("unit_cost", { precision: 18, scale: 4 }),
}, (table) => [
  unique("uniq_inv_vendor_return_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.returnId],
    foreignColumns: [invVendorReturns.orgId, invVendorReturns.id],
    name: "fk_inv_vendor_return_lines_return_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_vendor_return_lines_product_variant_id_org",
  }),
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
  createdByMembershipId: integer("created_by_membership_id"),
  approvedBy: text("approved_by").references(() => users.id),
  /** B9. See `invVendorReturns.approvedAt`. */
  approvedAt: timestamp("approved_at"),
  /**
   * B9, item 5. The credit note or refund this return expects, as an opaque
   * reference into whatever system issued it. Recorded so an accounting adapter
   * can reconcile against it; never consulted by the stock path, because a
   * credit that has not been raised is not a reason to leave the goods off the
   * shelf.
   */
  creditReference: text("credit_reference"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  postedAt: timestamp("posted_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.clientPartyId],
    foreignColumns: [businessParties.organizationId, businessParties.partyId],
    name: "fk_inv_customer_returns_client_party_id",
  }).onDelete("set null"),
  uniqueIndex("uniq_inv_cret_org_number").on(table.orgId, table.returnNumber),
  unique("uniq_inv_customer_returns_org_id").on(table.orgId, table.id),
  index("idx_inv_cret_org_status").on(table.orgId, table.status),
  /**
   * B9, item 3. "How much of this shipment has already come back" is asked on
   * every approval, and it is asked by source document.
   */
  index("idx_inv_cret_org_so").on(table.orgId, table.soId),
  index("idx_inv_cret_org_shipment").on(table.orgId, table.shipmentId),
]);

export const invCustomerReturnLines = pgTable("inv_customer_return_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  returnId: integer("return_id").references(() => invCustomerReturns.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id).notNull(),
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  serialId: integer("serial_id").references(() => invSerialNumbers.id, { onDelete: "set null" }),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  disposition: invCustomerReturnDispositionEnum("disposition"),
  notes: text("notes"),
  /**
   * INV-209. The disposition used to be declared when the return was created,
   * which is before anybody opened the box -- so it was a guess made from the
   * customer's description, and the guess posted stock. These record the
   * decision as a separate act with an author and a time, so "who decided this
   * was resaleable" has an answer.
   */
  inspectedAt: timestamp("inspected_at"),
  inspectedBy: text("inspected_by").references(() => users.id),
  inspectionNotes: text("inspection_notes"),
  /**
   * B9. Where these goods go. The create API has always accepted it and always
   * discarded it — there was no column — so the bin a warehouse had chosen was
   * re-guessed at posting time by `resolveTargetLocation`.
   */
  targetLocationId: integer("target_location_id").references(() => invLocations.id, { onDelete: "set null" }),
}, (table) => [
  unique("uniq_inv_customer_return_lines_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.returnId],
    foreignColumns: [invCustomerReturns.orgId, invCustomerReturns.id],
    name: "fk_inv_customer_return_lines_return_id_org",
  }),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_customer_return_lines_product_variant_id_org",
  }),
  index("idx_inv_cret_lines_return").on(table.returnId),
  index("idx_inv_customer_return_lines_variant").on(table.productVariantId),
]);

export const invVendorReturnsRelations = relations(invVendorReturns, ({ one, many }) => ({
  organization: one(organizations, { fields: [invVendorReturns.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invVendorReturns.createdBy], references: [users.id], relationName: "vretCreator" }),
  approver: one(users, { fields: [invVendorReturns.approvedBy], references: [users.id], relationName: "vretApprover" }),
  /**
   * B9. The list endpoint has always been read by a table with a Vendor column,
   * and there was no relation for it to project — so that column rendered a dash
   * for every row the product has ever shown.
   */
  vendor: one(invVendors, { fields: [invVendorReturns.vendorId], references: [invVendors.id] }),
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
