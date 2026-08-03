import { boolean, date, decimal, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { ledgerAccounts } from "./accounting";

export const accPeriodStatusEnum = pgEnum("acc_period_status", ["OPEN", "CLOSING", "CLOSED", "LOCKED"]);
export const accBasisEnum = pgEnum("acc_basis", ["ACCRUAL", "CASH"]);
export const accSystemPurposeEnum = pgEnum("acc_system_purpose", [
  "AR", "AP", "BANK_CLEARING", "SALES_INCOME", "DISCOUNT_GIVEN",
  "TAX_PAYABLE", "TAX_RECEIVABLE", "PAYROLL_PAYABLE", "EXPENSE_CLEARING",
  "RETAINED_EARNINGS", "OWNER_EQUITY", "PAYMENT_FEES", "REIMBURSEMENT_PAYABLE",
  "FX_GAIN_LOSS", "DEPRECIATION_EXPENSE", "ACCUM_DEPRECIATION",
  "SALARY_EXPENSE", "ASSET_DISPOSAL_GAIN_LOSS",
]);
export const finRecurFrequencyEnum = pgEnum("fin_recur_frequency", ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]);
export const finApprovalRecordTypeEnum = pgEnum("fin_approval_record_type", [
  "MANUAL_JOURNAL", "PURCHASE_BILL", "VENDOR_PAYMENT", "EXPENSE",
  "CREDIT_NOTE", "PERIOD_REOPEN", "BANK_ADJUSTMENT",
]);
export const finApprovalStatusEnum = pgEnum("fin_approval_status", ["PENDING", "APPROVED", "REJECTED"]);

export const accountingPeriods = pgTable("accounting_periods", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  status: accPeriodStatusEnum("status").default("OPEN").notNull(),
  closedBy: text("closed_by").references(() => users.id),
  closedAt: timestamp("closed_at"),
  lockedBy: text("locked_by").references(() => users.id),
  lockedAt: timestamp("locked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_accounting_periods_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_accounting_periods_org_start").on(table.orgId, table.startDate),
  index("idx_accounting_periods_org_status").on(table.orgId, table.status),
]);

export const accountingDimensions = pgTable("accounting_dimensions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  requiredForAccountTypes: jsonb("required_for_account_types").$type<string[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_accounting_dimensions_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_accounting_dimensions_org_key").on(table.orgId, table.key),
]);

export const accountingDimensionValues = pgTable("accounting_dimension_values", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  dimensionId: integer("dimension_id").references(() => accountingDimensions.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_accounting_dim_values_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_accounting_dim_values_org_dim_code").on(table.orgId, table.dimensionId, table.code),
  index("idx_accounting_dim_values_org_dim").on(table.orgId, table.dimensionId),
]);

export interface PaymentTerm {
  key: string;
  label: string;
  days: number;
  isDefault?: boolean;
}

export const accountingSettings = pgTable("accounting_settings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  baseCurrency: text("base_currency").default("INR").notNull(),
  fiscalYearStartMonth: integer("fiscal_year_start_month").default(4).notNull(),
  accountingBasis: accBasisEnum("accounting_basis").default("ACCRUAL").notNull(),
  taxRegistration: jsonb("tax_registration"),
  coaTemplate: text("coa_template"),
  setupCompletedAt: timestamp("setup_completed_at"),
  retainedEarningsAccountId: integer("retained_earnings_account_id").references(() => ledgerAccounts.id),
  paymentTerms: jsonb("payment_terms").$type<PaymentTerm[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_accounting_settings_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_accounting_settings_org").on(table.orgId),
]);

export const accNumberSequences = pgTable("acc_number_sequences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  prefix: text("prefix").notNull(),
  nextNumber: integer("next_number").default(1).notNull(),
  padding: integer("padding").default(4).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_acc_number_sequences_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_number_sequences_org_entity").on(table.orgId, table.entityType),
]);

export const accSystemAccountMap = pgTable("acc_system_account_map", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  purpose: accSystemPurposeEnum("purpose").notNull(),
  accountId: integer("account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_acc_system_account_map_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_system_account_map_org_purpose").on(table.orgId, table.purpose),
  index("idx_acc_system_account_map_org").on(table.orgId),
]);

export const finExchangeRates = pgTable("fin_exchange_rates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: decimal("rate", { precision: 18, scale: 8 }).notNull(),
  asOfDate: date("as_of_date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_exchange_rates_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_exchange_rates_org_pair_date").on(table.orgId, table.fromCurrency, table.toCurrency, table.asOfDate),
  index("idx_fin_exchange_rates_org_date").on(table.orgId, table.asOfDate),
]);

export const finApprovalPolicies = pgTable("fin_approval_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recordType: finApprovalRecordTypeEnum("record_type").notNull(),
  minAmount: decimal("min_amount", { precision: 18, scale: 4 }),
  approverRole: text("approver_role"),
  approverUserId: text("approver_user_id").references(() => users.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_approval_policies_org_id").on(table.orgId, table.id),
  index("idx_fin_approval_policies_org_type").on(table.orgId, table.recordType),
]);

export const finApprovalRequests = pgTable("fin_approval_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recordType: finApprovalRecordTypeEnum("record_type").notNull(),
  recordId: integer("record_id").notNull(),
  status: finApprovalStatusEnum("status").default("PENDING").notNull(),
  requestedBy: text("requested_by").references(() => users.id).notNull(),
  note: text("note"),
  decidedBy: text("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at"),
  decisionComment: text("decision_comment"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_approval_requests_org_id").on(table.orgId, table.id),
  index("idx_fin_approval_requests_org_status").on(table.orgId, table.status),
  index("idx_fin_approval_requests_org_type_record").on(table.orgId, table.recordType, table.recordId),
]);

export const finRecurringJournalTemplates = pgTable("fin_recurring_journal_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  frequency: finRecurFrequencyEnum("frequency").notNull(),
  nextRunDate: date("next_run_date"),
  lastRunDate: date("last_run_date"),
  endDate: date("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  lines: jsonb("lines").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_recur_journal_tmpls_org_id").on(table.orgId, table.id),
  index("idx_fin_recurring_journal_templates_org").on(table.orgId),
]);

export const accountingPeriodsRelations = relations(accountingPeriods, ({ one }) => ({
  organization: one(organizations, { fields: [accountingPeriods.orgId], references: [organizations.id] }),
  closedByUser: one(users, { fields: [accountingPeriods.closedBy], references: [users.id], relationName: "periodClosedBy" }),
  lockedByUser: one(users, { fields: [accountingPeriods.lockedBy], references: [users.id], relationName: "periodLockedBy" }),
}));

export const accountingDimensionsRelations = relations(accountingDimensions, ({ one, many }) => ({
  organization: one(organizations, { fields: [accountingDimensions.orgId], references: [organizations.id] }),
  values: many(accountingDimensionValues),
}));

export const accountingDimensionValuesRelations = relations(accountingDimensionValues, ({ one }) => ({
  organization: one(organizations, { fields: [accountingDimensionValues.orgId], references: [organizations.id] }),
  dimension: one(accountingDimensions, { fields: [accountingDimensionValues.dimensionId], references: [accountingDimensions.id] }),
}));

export const accountingSettingsRelations = relations(accountingSettings, ({ one }) => ({
  organization: one(organizations, { fields: [accountingSettings.orgId], references: [organizations.id] }),
  retainedEarningsAccount: one(ledgerAccounts, { fields: [accountingSettings.retainedEarningsAccountId], references: [ledgerAccounts.id] }),
}));

export const accSystemAccountMapRelations = relations(accSystemAccountMap, ({ one }) => ({
  organization: one(organizations, { fields: [accSystemAccountMap.orgId], references: [organizations.id] }),
  account: one(ledgerAccounts, { fields: [accSystemAccountMap.accountId], references: [ledgerAccounts.id] }),
}));

export const finExchangeRatesRelations = relations(finExchangeRates, ({ one }) => ({
  organization: one(organizations, { fields: [finExchangeRates.orgId], references: [organizations.id] }),
}));

export const finApprovalPoliciesRelations = relations(finApprovalPolicies, ({ one }) => ({
  organization: one(organizations, { fields: [finApprovalPolicies.orgId], references: [organizations.id] }),
  approverUser: one(users, { fields: [finApprovalPolicies.approverUserId], references: [users.id] }),
}));

export const finApprovalRequestsRelations = relations(finApprovalRequests, ({ one }) => ({
  organization: one(organizations, { fields: [finApprovalRequests.orgId], references: [organizations.id] }),
  requestedByUser: one(users, { fields: [finApprovalRequests.requestedBy], references: [users.id], relationName: "approvalRequestedBy" }),
  decidedByUser: one(users, { fields: [finApprovalRequests.decidedBy], references: [users.id], relationName: "approvalDecidedBy" }),
}));

export const finRecurringJournalTemplatesRelations = relations(finRecurringJournalTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [finRecurringJournalTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [finRecurringJournalTemplates.createdBy], references: [users.id] }),
}));

