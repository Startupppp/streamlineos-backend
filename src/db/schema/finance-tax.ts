import { boolean, date, decimal, index, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";
import { ledgerAccounts, journalEntries } from "./accounting";

export const accTaxTypeEnum = pgEnum("acc_tax_type", ["GST", "CGST_SGST", "IGST", "VAT", "TDS", "TCS", "EXEMPT", "ZERO_RATED"]);

export const accTaxCodes = pgTable("acc_tax_codes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  rate: decimal("rate", { precision: 5, scale: 2 }).notNull(),
  taxType: accTaxTypeEnum("tax_type").notNull(),
  isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),
  collectedAccountId: integer("collected_account_id").references(() => ledgerAccounts.id),
  paidAccountId: integer("paid_account_id").references(() => ledgerAccounts.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_acc_tax_codes_org_code").on(table.orgId, table.code),
  index("idx_acc_tax_codes_org_type").on(table.orgId, table.taxType),
]);

export const accTaxPayments = pgTable("acc_tax_payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  taxType: accTaxTypeEnum("tax_type").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  paidDate: date("paid_date"),
  reference: text("reference"),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_acc_tax_payments_org_type").on(table.orgId, table.taxType),
  index("idx_acc_tax_payments_org_period").on(table.orgId, table.periodStart, table.periodEnd),
]);

export const accTaxCodesRelations = relations(accTaxCodes, ({ one }) => ({
  organization: one(organizations, { fields: [accTaxCodes.orgId], references: [organizations.id] }),
  collectedAccount: one(ledgerAccounts, { fields: [accTaxCodes.collectedAccountId], references: [ledgerAccounts.id], relationName: "taxCollectedAccount" }),
  paidAccount: one(ledgerAccounts, { fields: [accTaxCodes.paidAccountId], references: [ledgerAccounts.id], relationName: "taxPaidAccount" }),
}));

export const accTaxPaymentsRelations = relations(accTaxPayments, ({ one }) => ({
  organization: one(organizations, { fields: [accTaxPayments.orgId], references: [organizations.id] }),
  journalEntry: one(journalEntries, { fields: [accTaxPayments.journalEntryId], references: [journalEntries.id] }),
  creator: one(users, { fields: [accTaxPayments.createdBy], references: [users.id] }),
}));

export type AccTaxCode = typeof accTaxCodes.$inferSelect;
export type NewAccTaxCode = typeof accTaxCodes.$inferInsert;
export type AccTaxPayment = typeof accTaxPayments.$inferSelect;
