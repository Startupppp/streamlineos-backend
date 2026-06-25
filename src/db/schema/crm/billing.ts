import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invoiceStatusEnum, supportTicketStatusEnum, supportTicketPriorityEnum, quoteStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { projects } from "../projects";
import { clients, clientAccounts } from "./contacts";
import { deals } from "./deals";

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id),
  projectId: integer("project_id").references(() => projects.id),
  invoiceNumber: text("invoice_number").notNull(),
  status: invoiceStatusEnum("status").default("DRAFT").notNull(),
  lineItems: jsonb("line_items").$type<{ description: string; quantity: number; rate: number; amount: number }[]>().default([]).notNull(),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  discount: decimal("discount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  dueDate: date("due_date"),
  notes: text("notes"),
  sentAt: timestamp("sent_at"),
  paidAt: timestamp("paid_at"),
  viewedAt: timestamp("viewed_at"),
  terms: text("terms"),
  placeOfSupply: text("place_of_supply"),
  customerGstin: text("customer_gstin"),
  supplierGstin: text("supplier_gstin"),
  reverseCharge: boolean("reverse_charge").default(false).notNull(),
  taxInclusive: boolean("tax_inclusive").default(false).notNull(),
  cgstAmount: decimal("cgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  sgstAmount: decimal("sgst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  igstAmount: decimal("igst_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  isRecurring: boolean("is_recurring").default(false).notNull(),
  recurringInterval: text("recurring_interval"),
  nextRecurringDate: date("next_recurring_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_invoices_org_status").on(table.orgId, table.status),
  index("idx_invoices_client").on(table.clientId),
  index("idx_invoices_project").on(table.projectId),
  index("idx_invoices_due_date").on(table.dueDate),
]);

export const invoiceItems = pgTable("invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
  description: text("description").notNull(),
  hsnSacCode: text("hsn_sac_code"),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  rate: decimal("rate", { precision: 18, scale: 4 }).notNull(),
  gstRate: decimal("gst_rate", { precision: 5, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  lineOrder: integer("line_order").notNull(),
}, (table) => [
  index("idx_invoice_items_invoice").on(table.invoiceId),
]);

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  paymentDate: date("payment_date").notNull(),
  paymentMethod: text("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_payments_invoice").on(table.invoiceId),
  index("idx_payments_org_date").on(table.orgId, table.paymentDate),
]);

export const purchaseBills = pgTable("purchase_bills", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  vendorId: integer("vendor_id").references(() => clients.id),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_purchase_bills_org_status").on(table.orgId, table.status),
  index("idx_purchase_bills_vendor").on(table.vendorId),
  index("idx_purchase_bills_due_date").on(table.dueDate),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_vendor_payments_bill").on(table.billId),
  index("idx_vendor_payments_org_date").on(table.orgId, table.paymentDate),
]);

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id),
  assigneeId: text("assignee_id").references(() => users.id),
  title: text("title").notNull(),
  category: text("category"),
  description: text("description"),
  status: supportTicketStatusEnum("status").default("OPEN").notNull(),
  priority: supportTicketPriorityEnum("priority").default("MEDIUM").notNull(),
  slaDeadline: timestamp("sla_deadline"),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_support_tickets_org_status").on(table.orgId, table.status),
  index("idx_support_tickets_assignee").on(table.assigneeId),
  index("idx_support_tickets_client").on(table.clientId),
  index("idx_support_tickets_priority").on(table.priority),
  index("idx_support_tickets_sla").on(table.slaDeadline),
]);

export const supportTicketMessages = pgTable("support_ticket_messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
  authorId: text("author_id").references(() => users.id).notNull(),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").default(false).notNull(),
  attachments: jsonb("attachments").$type<{ fileName: string; fileUrl: string; fileSize: number; mimeType: string }[]>().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_support_ticket_messages_ticket").on(table.ticketId),
  index("idx_support_ticket_messages_author").on(table.authorId),
]);

export const quotes = pgTable("quotes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
  clientId: integer("client_id").references(() => clientAccounts.id, { onDelete: "set null" }),
  quoteNumber: text("quote_number").notNull(),
  subject: text("subject").notNull(),
  description: text("description"),
  status: quoteStatusEnum("status").default("DRAFT").notNull(),
  currency: text("currency").default("INR").notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
  taxAmount: decimal("tax_amount", { precision: 15, scale: 2 }).default("0").notNull(),
  discountAmount: decimal("discount_amount", { precision: 15, scale: 2 }).default("0").notNull(),
  netAmount: decimal("net_amount", { precision: 15, scale: 2 }).notNull(),
  validUntil: date("valid_until").notNull(),
  termsAndConditions: text("terms_and_conditions"),
  createdById: text("created_by_id").references(() => users.id).notNull(),
  sentAt: timestamp("sent_at"),
  acceptedAt: timestamp("accepted_at"),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_quotes_org_status").on(table.orgId, table.status),
  index("idx_quotes_deal").on(table.dealId),
  index("idx_quotes_client").on(table.clientId),
  index("idx_quotes_created_by").on(table.createdById),
  uniqueIndex("idx_quotes_number").on(table.orgId, table.quoteNumber),
]);

export const quoteLineItems = pgTable("quote_line_items", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "cascade" }).notNull(),
  description: text("description").notNull(),
  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 15, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  organization: one(organizations, { fields: [invoices.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [invoices.clientId], references: [clients.id] }),
  project: one(projects, { fields: [invoices.projectId], references: [projects.id] }),
  creator: one(users, { fields: [invoices.createdBy], references: [users.id] }),
  payments: many(payments),
  items: many(invoiceItems),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  organization: one(organizations, { fields: [payments.orgId], references: [organizations.id] }),
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  creator: one(users, { fields: [payments.createdBy], references: [users.id] }),
}));

export const purchaseBillsRelations = relations(purchaseBills, ({ one, many }) => ({
  organization: one(organizations, { fields: [purchaseBills.orgId], references: [organizations.id] }),
  vendor: one(clients, { fields: [purchaseBills.vendorId], references: [clients.id] }),
  creator: one(users, { fields: [purchaseBills.createdBy], references: [users.id] }),
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

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  organization: one(organizations, { fields: [supportTickets.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [supportTickets.clientId], references: [clients.id] }),
  assignee: one(users, { fields: [supportTickets.assigneeId], references: [users.id] }),
  creator: one(users, { fields: [supportTickets.createdBy], references: [users.id] }),
  messages: many(supportTicketMessages),
}));

export const supportTicketMessagesRelations = relations(supportTicketMessages, ({ one }) => ({
  ticket: one(supportTickets, { fields: [supportTicketMessages.ticketId], references: [supportTickets.id] }),
  author: one(users, { fields: [supportTicketMessages.authorId], references: [users.id] }),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  organization: one(organizations, { fields: [quotes.orgId], references: [organizations.id] }),
  deal: one(deals, { fields: [quotes.dealId], references: [deals.id] }),
  client: one(clientAccounts, { fields: [quotes.clientId], references: [clientAccounts.id] }),
  createdBy: one(users, { fields: [quotes.createdById], references: [users.id] }),
  lineItems: many(quoteLineItems),
}));

export const quoteLineItemsRelations = relations(quoteLineItems, ({ one }) => ({
  quote: one(quotes, { fields: [quoteLineItems.quoteId], references: [quotes.id] }),
}));
