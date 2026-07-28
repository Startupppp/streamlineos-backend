import { boolean, date, decimal, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { invoices, payments, purchaseBills, vendorPayments } from "../crm/invoicing";
import { clients } from "../crm/contacts";
import { finRecurFrequencyEnum } from "./accounting-core";

export const finCreditNoteStatusEnum = pgEnum("fin_credit_note_status", ["DRAFT", "POSTED", "APPLIED", "VOID"]);
export const finReminderChannelEnum = pgEnum("fin_reminder_channel", ["EMAIL", "WHATSAPP"]);
export const finCollectionActivityTypeEnum = pgEnum("fin_collection_activity_type", ["NOTE", "PROMISE_TO_PAY", "CALL", "EMAIL"]);
export const finPaymentRunStatusEnum = pgEnum("fin_payment_run_status", ["DRAFT", "APPROVED", "COMPLETED", "CANCELLED"]);
export const finPaymentRunItemStatusEnum = pgEnum("fin_payment_run_item_status", ["PENDING", "PAID", "SKIPPED"]);

export const creditNotes = pgTable("credit_notes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  creditNoteNumber: text("credit_note_number").notNull(),
  clientId: integer("client_id").references(() => clients.id),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  status: finCreditNoteStatusEnum("status").default("DRAFT").notNull(),
  reason: text("reason"),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  cgstAmount: decimal("cgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  sgstAmount: decimal("sgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  igstAmount: decimal("igst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  appliedAmount: decimal("applied_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  placeOfSupply: text("place_of_supply"),
  customerGstin: text("customer_gstin"),
  supplierGstin: text("supplier_gstin"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_credit_notes_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_credit_notes_org_number").on(table.orgId, table.creditNoteNumber),
  index("idx_credit_notes_org_status").on(table.orgId, table.status),
  index("idx_credit_notes_client").on(table.clientId),
  index("idx_credit_notes_invoice").on(table.invoiceId),
]);

export const creditNoteItems = pgTable("credit_note_items", {
  id: serial("id").primaryKey(),
  creditNoteId: integer("credit_note_id").references(() => creditNotes.id, { onDelete: "cascade" }).notNull(),
  description: text("description").notNull(),
  hsnSacCode: text("hsn_sac_code"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  rate: decimal("rate", { precision: 18, scale: 4 }).notNull(),
  gstRate: decimal("gst_rate", { precision: 5, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").notNull(),
}, (table) => [
  index("idx_credit_note_items_cn").on(table.creditNoteId),
]);

export const finPaymentAllocations = pgTable("fin_payment_allocations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  paymentId: integer("payment_id").references(() => payments.id, { onDelete: "cascade" }).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_payment_allocations_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_payment_allocations_pay_inv").on(table.paymentId, table.invoiceId),
  index("idx_fin_payment_allocations_org").on(table.orgId),
  index("idx_fin_payment_allocations_invoice").on(table.invoiceId),
]);

export const vendorCredits = pgTable("vendor_credits", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  vendorCreditNumber: text("vendor_credit_number").notNull(),
  vendorId: integer("vendor_id").references(() => clients.id),
  billId: integer("bill_id").references(() => purchaseBills.id, { onDelete: "set null" }),
  status: finCreditNoteStatusEnum("status").default("DRAFT").notNull(),
  reason: text("reason"),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  appliedAmount: decimal("applied_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_vendor_credits_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_vendor_credits_org_number").on(table.orgId, table.vendorCreditNumber),
  index("idx_vendor_credits_org_status").on(table.orgId, table.status),
  index("idx_vendor_credits_vendor").on(table.vendorId),
]);

export const vendorCreditItems = pgTable("vendor_credit_items", {
  id: serial("id").primaryKey(),
  vendorCreditId: integer("vendor_credit_id").references(() => vendorCredits.id, { onDelete: "cascade" }).notNull(),
  description: text("description").notNull(),
  hsnSacCode: text("hsn_sac_code"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  rate: decimal("rate", { precision: 18, scale: 4 }).notNull(),
  gstRate: decimal("gst_rate", { precision: 5, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").notNull(),
}, (table) => [
  index("idx_vendor_credit_items_vc").on(table.vendorCreditId),
]);

export const finVendorPaymentAllocations = pgTable("fin_vendor_payment_allocations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  vendorPaymentId: integer("vendor_payment_id").references(() => vendorPayments.id, { onDelete: "cascade" }).notNull(),
  billId: integer("bill_id").references(() => purchaseBills.id, { onDelete: "cascade" }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_vendor_pay_alloc_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_vendor_pay_alloc_pay_bill").on(table.vendorPaymentId, table.billId),
  index("idx_fin_vendor_payment_allocations_org").on(table.orgId),
  index("idx_fin_vendor_payment_allocations_bill").on(table.billId),
]);

export const finRecurringInvoiceTemplates = pgTable("fin_recurring_invoice_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  clientId: integer("client_id").references(() => clients.id),
  frequency: finRecurFrequencyEnum("frequency").notNull(),
  nextRunDate: date("next_run_date"),
  lastRunDate: date("last_run_date"),
  endDate: date("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  payload: jsonb("payload").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_recur_inv_tmpls_org_id").on(table.orgId, table.id),
  index("idx_fin_recurring_invoice_templates_org").on(table.orgId),
]);

export const finRecurringBillTemplates = pgTable("fin_recurring_bill_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  vendorId: integer("vendor_id").references(() => clients.id),
  frequency: finRecurFrequencyEnum("frequency").notNull(),
  nextRunDate: date("next_run_date"),
  lastRunDate: date("last_run_date"),
  endDate: date("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  payload: jsonb("payload").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_recur_bill_tmpls_org_id").on(table.orgId, table.id),
  index("idx_fin_recurring_bill_templates_org").on(table.orgId),
]);

export const finReminderPolicies = pgTable("fin_reminder_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  offsets: jsonb("offsets").$type<number[]>().notNull(),
  channel: finReminderChannelEnum("channel").default("EMAIL").notNull(),
  template: text("template"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_reminder_policies_org_id").on(table.orgId, table.id),
  index("idx_fin_reminder_policies_org").on(table.orgId),
]);

export const finReminderLog = pgTable("fin_reminder_log", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  channel: finReminderChannelEnum("channel").notNull(),
  offsetDays: integer("offset_days").notNull(),
  status: text("status").notNull(),
}, (table) => [
  unique("uniq_fin_reminder_log_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_reminder_log_org_inv_offset").on(table.orgId, table.invoiceId, table.offsetDays),
  index("idx_fin_reminder_log_org_invoice").on(table.orgId, table.invoiceId),
]);

export const finCollectionActivities = pgTable("fin_collection_activities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  type: finCollectionActivityTypeEnum("type").notNull(),
  note: text("note"),
  promisedDate: date("promised_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_collection_activities_org_id").on(table.orgId, table.id),
  index("idx_fin_collection_activities_org_client").on(table.orgId, table.clientId),
  index("idx_fin_collection_activities_invoice").on(table.invoiceId),
]);

export const finPaymentRuns = pgTable("fin_payment_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  status: finPaymentRunStatusEnum("status").default("DRAFT").notNull(),
  scheduledDate: date("scheduled_date"),
  totalAmount: decimal("total_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_payment_runs_org_id").on(table.orgId, table.id),
  index("idx_fin_payment_runs_org_status").on(table.orgId, table.status),
]);

export const finPaymentRunItems = pgTable("fin_payment_run_items", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").references(() => finPaymentRuns.id, { onDelete: "cascade" }).notNull(),
  billId: integer("bill_id").references(() => purchaseBills.id).notNull(),
  vendorId: integer("vendor_id").references(() => clients.id),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  status: finPaymentRunItemStatusEnum("status").default("PENDING").notNull(),
  vendorPaymentId: integer("vendor_payment_id").references(() => vendorPayments.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_fin_payment_run_items_run").on(table.runId),
  index("idx_fin_payment_run_items_bill").on(table.billId),
]);

export const creditNotesRelations = relations(creditNotes, ({ one, many }) => ({
  organization: one(organizations, { fields: [creditNotes.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [creditNotes.clientId], references: [clients.id] }),
  invoice: one(invoices, { fields: [creditNotes.invoiceId], references: [invoices.id] }),
  creator: one(users, { fields: [creditNotes.createdBy], references: [users.id] }),
  items: many(creditNoteItems),
}));

export const creditNoteItemsRelations = relations(creditNoteItems, ({ one }) => ({
  creditNote: one(creditNotes, { fields: [creditNoteItems.creditNoteId], references: [creditNotes.id] }),
}));

export const finPaymentAllocationsRelations = relations(finPaymentAllocations, ({ one }) => ({
  organization: one(organizations, { fields: [finPaymentAllocations.orgId], references: [organizations.id] }),
  payment: one(payments, { fields: [finPaymentAllocations.paymentId], references: [payments.id] }),
  invoice: one(invoices, { fields: [finPaymentAllocations.invoiceId], references: [invoices.id] }),
}));

export const vendorCreditsRelations = relations(vendorCredits, ({ one, many }) => ({
  organization: one(organizations, { fields: [vendorCredits.orgId], references: [organizations.id] }),
  vendor: one(clients, { fields: [vendorCredits.vendorId], references: [clients.id] }),
  bill: one(purchaseBills, { fields: [vendorCredits.billId], references: [purchaseBills.id] }),
  creator: one(users, { fields: [vendorCredits.createdBy], references: [users.id] }),
  items: many(vendorCreditItems),
}));

export const vendorCreditItemsRelations = relations(vendorCreditItems, ({ one }) => ({
  vendorCredit: one(vendorCredits, { fields: [vendorCreditItems.vendorCreditId], references: [vendorCredits.id] }),
}));

export const finVendorPaymentAllocationsRelations = relations(finVendorPaymentAllocations, ({ one }) => ({
  organization: one(organizations, { fields: [finVendorPaymentAllocations.orgId], references: [organizations.id] }),
  vendorPayment: one(vendorPayments, { fields: [finVendorPaymentAllocations.vendorPaymentId], references: [vendorPayments.id] }),
  bill: one(purchaseBills, { fields: [finVendorPaymentAllocations.billId], references: [purchaseBills.id] }),
}));

export const finRecurringInvoiceTemplatesRelations = relations(finRecurringInvoiceTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [finRecurringInvoiceTemplates.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [finRecurringInvoiceTemplates.clientId], references: [clients.id] }),
  creator: one(users, { fields: [finRecurringInvoiceTemplates.createdBy], references: [users.id] }),
}));

export const finRecurringBillTemplatesRelations = relations(finRecurringBillTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [finRecurringBillTemplates.orgId], references: [organizations.id] }),
  vendor: one(clients, { fields: [finRecurringBillTemplates.vendorId], references: [clients.id] }),
  creator: one(users, { fields: [finRecurringBillTemplates.createdBy], references: [users.id] }),
}));

export const finReminderPoliciesRelations = relations(finReminderPolicies, ({ one }) => ({
  organization: one(organizations, { fields: [finReminderPolicies.orgId], references: [organizations.id] }),
}));

export const finCollectionActivitiesRelations = relations(finCollectionActivities, ({ one }) => ({
  organization: one(organizations, { fields: [finCollectionActivities.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [finCollectionActivities.clientId], references: [clients.id] }),
  invoice: one(invoices, { fields: [finCollectionActivities.invoiceId], references: [invoices.id] }),
  creator: one(users, { fields: [finCollectionActivities.createdBy], references: [users.id] }),
}));

export const finPaymentRunsRelations = relations(finPaymentRuns, ({ one, many }) => ({
  organization: one(organizations, { fields: [finPaymentRuns.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [finPaymentRuns.createdBy], references: [users.id], relationName: "paymentRunCreatedBy" }),
  approver: one(users, { fields: [finPaymentRuns.approvedBy], references: [users.id], relationName: "paymentRunApprovedBy" }),
  items: many(finPaymentRunItems),
}));

export const finPaymentRunItemsRelations = relations(finPaymentRunItems, ({ one }) => ({
  run: one(finPaymentRuns, { fields: [finPaymentRunItems.runId], references: [finPaymentRuns.id] }),
  bill: one(purchaseBills, { fields: [finPaymentRunItems.billId], references: [purchaseBills.id] }),
  vendor: one(clients, { fields: [finPaymentRunItems.vendorId], references: [clients.id] }),
  vendorPayment: one(vendorPayments, { fields: [finPaymentRunItems.vendorPaymentId], references: [vendorPayments.id] }),
}));

