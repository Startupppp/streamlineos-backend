import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

/**
 * The payables side of `invoicing.ts`: what a vendor bills this organisation,
 * the lines on that bill, and what the organisation pays against it.
 *
 * Moved out whole, with indexes and relations, when `invoicing.ts` passed 300
 * lines. `invoicing.ts` re-exports every name declared here, so no importer
 * changed. Nothing in this file references an invoice or a quote, which is
 * what lets it stand alone without importing back from `invoicing.ts`.
 */

export const purchaseBills = pgTable("purchase_bills", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  vendorId: integer("vendor_id"),
  /**
  * The party this row belongs to. Ticket 08's expand.
  *
  * Beside `vendor_id` rather than replacing it: every existing reader keeps
  * working while readers move over one at a time, and the old column goes in
  * the contract migration once none is left. Nullable until then -- a null
  * means "not yet backfilled", which is a state worth being able to see.
  */
  vendorPartyId: text("vendor_party_id"),
  billNumber: text("bill_number").notNull(),
  vendorBillNumber: text("vendor_bill_number"),
  billDate: date("bill_date").notNull(),
  dueDate: date("due_date"),
  status: text("status").default("DRAFT").notNull(),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  cgstAmount: decimal("cgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  sgstAmount: decimal("sgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  igstAmount: decimal("igst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  discount: decimal("discount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  amountPaid: decimal("amount_paid", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  placeOfSupply: text("place_of_supply"),
  vendorGstin: text("vendor_gstin"),
  supplierGstin: text("supplier_gstin"),
  reverseCharge: boolean("reverse_charge").default(false).notNull(),
  notes: text("notes"),
  expenseAccountCode: text("expense_account_code"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  exchangeRate: decimal("exchange_rate", { precision: 18, scale: 8 }).default("1").notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  recurringTemplateId: integer("recurring_template_id"),
}, (table) => [
  index("idx_purchase_bills_org_status").on(table.orgId, table.status),
  index("idx_purchase_bills_vendor").on(table.vendorId),
  index("idx_purchase_bills_due_date").on(table.dueDate),
  unique("uniq_purchase_bills_org_id").on(table.orgId, table.id),
]);

export const purchaseBillItems = pgTable("purchase_bill_items", {
  id: serial("id").primaryKey(),
  billId: integer("bill_id").references(() => purchaseBills.id, { onDelete: "cascade" }).notNull(),
  description: text("description").notNull(),
  hsnSacCode: text("hsn_sac_code"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  rate: decimal("rate", { precision: 18, scale: 4 }).notNull(),
  gstRate: decimal("gst_rate", { precision: 5, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").notNull(),
}, (table) => [
  index("idx_purchase_bill_items_bill").on(table.billId),
]);

export const vendorPayments = pgTable("vendor_payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  billId: integer("bill_id").references(() => purchaseBills.id, { onDelete: "cascade" }).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  paymentDate: date("payment_date").notNull(),
  paymentMethod: text("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_vendor_payments_bill").on(table.billId),
  index("idx_vendor_payments_org_date").on(table.orgId, table.paymentDate),
  unique("uniq_vendor_payments_org_id").on(table.orgId, table.id),
]);

export const purchaseBillsRelations = relations(purchaseBills, ({ one, many }) => ({
  organization: one(organizations, { fields: [purchaseBills.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [purchaseBills.createdBy], references: [users.id], relationName: "billCreatedBy" }),
  approver: one(users, { fields: [purchaseBills.approvedBy], references: [users.id], relationName: "billApprovedBy" }),
  items: many(purchaseBillItems),
}));

export const purchaseBillItemsRelations = relations(purchaseBillItems, ({ one }) => ({
  bill: one(purchaseBills, { fields: [purchaseBillItems.billId], references: [purchaseBills.id] }),
}));

export const vendorPaymentsRelations = relations(vendorPayments, ({ one }) => ({
  organization: one(organizations, { fields: [vendorPayments.orgId], references: [organizations.id] }),
  bill: one(purchaseBills, { fields: [vendorPayments.billId], references: [purchaseBills.id] }),
  creator: one(users, { fields: [vendorPayments.createdBy], references: [users.id] }),
}));
