import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  bigint,
  date,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  expenseStatusEnum,
  reimbursementStatusEnum,
  loanStatusEnum,
  bonusTypeEnum,
  fnfStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { journalEntries, ledgerAccounts } from "../accounting/accounting";
import { projects } from "../build";
import { resignations } from "../hr/offboarding";
import { assets } from "../hr/assets";

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    budgetLimit: decimal("budget_limit", { precision: 15, scale: 2 }),
    budgetPeriod: text("budget_period").default("MONTHLY").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    ledgerAccountId: integer("ledger_account_id").references(
      () => ledgerAccounts.id,
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_expense_categories_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_expense_categories_org_name").on(table.orgId, table.name),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => expenseCategories.id, {
      onDelete: "set null",
    }),
    category: text("category").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    currency: text("currency").default("INR").notNull(),
    description: text("description"),
    receiptUrl: text("receipt_url"),
    receiptFileName: text("receipt_file_name"),
    merchant: text("merchant"),
    receiptNumber: text("receipt_number"),
    receiptHash: text("receipt_hash"),
    taxAmount: decimal("tax_amount", { precision: 12, scale: 2 }),
    paymentMethod: text("payment_method"),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    status: expenseStatusEnum("status").default("PENDING").notNull(),
    approverId: text("approver_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    rejectionReason: text("rejection_reason"),
    paidAt: timestamp("paid_at"),
    transactionRef: text("transaction_ref"),
    reimbursementBatchId: integer("reimbursement_batch_id"),
    postedJournalEntryId: integer("posted_journal_entry_id").references(
      () => journalEntries.id,
    ),
    policyFlag: text("policy_flag"),
    expenseDate: date("expense_date").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_expenses_org_id").on(table.orgId, table.id),
    index("idx_expenses_user_id").on(table.userId),
    index("idx_expenses_org_status_date").on(
      table.orgId,
      table.status,
      table.expenseDate,
    ),
    index("idx_expenses_category").on(table.categoryId),
    index("idx_expenses_org_receipt_hash").on(table.orgId, table.receiptHash),
  ],
);

export const reimbursements = pgTable(
  "reimbursements",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    category: text("category").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    description: text("description"),
    receiptUrl: text("receipt_url"),
    status: reimbursementStatusEnum("status").default("PENDING").notNull(),
    payrollMonth: text("payroll_month"),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    paidAt: timestamp("paid_at"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_reimbursements_org_id").on(table.orgId, table.id),
    index("idx_reimbursements_org").on(table.orgId),
    index("idx_reimbursements_user").on(table.userId),
  ],
);

export const salaryLoans = pgTable(
  "salary_loans",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    reason: text("reason"),
    emiAmount: decimal("emi_amount", { precision: 15, scale: 2 }),
    totalEmis: integer("total_emis"),
    paidEmis: integer("paid_emis").default(0).notNull(),
    status: loanStatusEnum("status").default("PENDING").notNull(),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    disbursedAt: timestamp("disbursed_at"),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_salary_loans_org_id").on(table.orgId, table.id),
    index("idx_loans_org").on(table.orgId),
    index("idx_loans_user").on(table.userId),
    index("idx_loans_org_status").on(table.orgId, table.status),
  ],
);

export const bonuses = pgTable(
  "bonuses",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    type: bonusTypeEnum("type").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }),
    reason: text("reason"),
    month: text("month"),
    taxable: boolean("taxable").default(true).notNull(),
    status: text("status").default("PENDING").notNull(),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_bonuses_org_id").on(table.orgId, table.id),
    index("idx_bonuses_user").on(table.userId),
    index("idx_bonuses_org_status").on(table.orgId, table.status),
  ],
);

export const fnfSettlements = pgTable(
  "fnf_settlements",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    resignationId: integer("resignation_id").references(() => resignations.id, {
      onDelete: "set null",
    }),
    basicDues: decimal("basic_dues", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    leaveEncashment: decimal("leave_encashment", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    bonusDue: decimal("bonus_due", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    deductions: decimal("deductions", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    loanRecovery: decimal("loan_recovery", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    netPayable: decimal("net_payable", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    status: fnfStatusEnum("status").default("DRAFT").notNull(),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    reimbursementsDue: decimal("reimbursements_due", {
      precision: 15,
      scale: 2,
    })
      .default("0")
      .notNull(),
    assetRecovery: decimal("asset_recovery", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    noticeRecovery: decimal("notice_recovery", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    otherDeductions: decimal("other_deductions", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    statementPublishedAt: timestamp("statement_published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_fnf_settlements_org_id").on(table.orgId, table.id),
    index("idx_fnf_user").on(table.userId),
    index("idx_fnf_settlements_org_status").on(table.orgId, table.status),
  ],
);

export const assetReturns = pgTable(
  "asset_returns",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id)
      .notNull(),
    assetId: integer("asset_id").references(() => assets.id),
    assetName: text("asset_name").notNull(),
    status: text("status").default("PENDING").notNull(),
    returnedAt: timestamp("returned_at"),
    condition: text("condition"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_asset_returns_org_id").on(table.orgId, table.id),
    index("idx_asset_returns_user").on(table.userId),
    index("idx_asset_returns_org_status").on(table.orgId, table.status),
  ],
);

export const expenseCategoriesRelations = relations(
  expenseCategories,
  ({ many }) => ({
    expenses: many(expenses),
  }),
);

export const expensesRelations = relations(expenses, ({ one }) => ({
  user: one(users, {
    fields: [expenses.userId],
    references: [users.id],
    relationName: "expenseUser",
  }),
  approver: one(users, {
    fields: [expenses.approverId],
    references: [users.id],
    relationName: "expenseApprover",
  }),
  expenseCategory: one(expenseCategories, {
    fields: [expenses.categoryId],
    references: [expenseCategories.id],
  }),
  project: one(projects, {
    fields: [expenses.projectId],
    references: [projects.id],
  }),
  postedJournalEntry: one(journalEntries, {
    fields: [expenses.postedJournalEntryId],
    references: [journalEntries.id],
  }),
}));

export const reimbursementsRelations = relations(reimbursements, ({ one }) => ({
  user: one(users, { fields: [reimbursements.userId], references: [users.id] }),
  approver: one(users, {
    fields: [reimbursements.approvedBy],
    references: [users.id],
    relationName: "reimbursementApprover",
  }),
}));

export const salaryLoansRelations = relations(salaryLoans, ({ one }) => ({
  user: one(users, { fields: [salaryLoans.userId], references: [users.id] }),
  approver: one(users, {
    fields: [salaryLoans.approvedBy],
    references: [users.id],
    relationName: "loanApprover",
  }),
}));

export const bonusesRelations = relations(bonuses, ({ one }) => ({
  user: one(users, { fields: [bonuses.userId], references: [users.id] }),
  approver: one(users, {
    fields: [bonuses.approvedBy],
    references: [users.id],
    relationName: "bonusApprover",
  }),
}));

export const fnfSettlementsRelations = relations(fnfSettlements, ({ one }) => ({
  user: one(users, { fields: [fnfSettlements.userId], references: [users.id] }),
  resignation: one(resignations, {
    fields: [fnfSettlements.resignationId],
    references: [resignations.id],
  }),
}));

export const assetReturnsRelations = relations(assetReturns, ({ one }) => ({
  user: one(users, { fields: [assetReturns.userId], references: [users.id] }),
  asset: one(assets, {
    fields: [assetReturns.assetId],
    references: [assets.id],
  }),
}));
