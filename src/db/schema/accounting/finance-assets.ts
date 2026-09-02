import { date, decimal, foreignKey, index, integer, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { ledgerAccounts, journalEntries } from "./accounting";
import { purchaseBills } from "../crm/invoicing";
import { clients } from "../crm/contacts";

export const accDepreciationMethodEnum = pgEnum("acc_depreciation_method", ["STRAIGHT_LINE", "DECLINING_BALANCE", "UNITS_OF_PRODUCTION"]);
export const accAssetStatusEnum = pgEnum("acc_asset_status", ["DRAFT", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"]);
export const accDepreciationLineStatusEnum = pgEnum("acc_depreciation_line_status", ["SCHEDULED", "POSTED"]);
export const accDepreciationRunStatusEnum = pgEnum("acc_depreciation_run_status", ["DRAFT", "POSTED"]);

export const accAssetCategories = pgTable("acc_asset_categories", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  assetAccountId: integer("asset_account_id").notNull(),
  depreciationExpenseAccountId: integer("depreciation_expense_account_id").notNull(),
  accumulatedDepreciationAccountId: integer("accumulated_depreciation_account_id").notNull(),
  defaultMethod: accDepreciationMethodEnum("default_method").default("STRAIGHT_LINE").notNull(),
  defaultUsefulLifeMonths: integer("default_useful_life_months"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.accumulatedDepreciationAccountId], foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id], name: "fk_acc_asset_categories_accumulated_depreciation_account_id_org" }),
  foreignKey({ columns: [table.orgId, table.assetAccountId], foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id], name: "fk_acc_asset_categories_asset_account_id_org" }),
  foreignKey({ columns: [table.orgId, table.depreciationExpenseAccountId], foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id], name: "fk_acc_asset_categories_depreciation_expense_account_id_org" }),
  unique("uniq_acc_asset_categories_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_asset_categories_org_name").on(table.orgId, table.name),
  index("idx_acc_asset_categories_org").on(table.orgId),
]);

export const accFixedAssets = pgTable("acc_fixed_assets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  assetNumber: text("asset_number").notNull(),
  name: text("name").notNull(),
  categoryId: integer("category_id").notNull(),
  acquisitionDate: date("acquisition_date").notNull(),
  acquisitionCost: decimal("acquisition_cost", { precision: 18, scale: 4 }).notNull(),
  salvageValue: decimal("salvage_value", { precision: 18, scale: 4 }).default("0").notNull(),
  usefulLifeMonths: integer("useful_life_months").notNull(),
  depreciationMethod: accDepreciationMethodEnum("depreciation_method").default("STRAIGHT_LINE").notNull(),
  vendorId: integer("vendor_id").references(() => clients.id),
  billId: integer("bill_id"),
  status: accAssetStatusEnum("status").default("DRAFT").notNull(),
  accumulatedDepreciation: decimal("accumulated_depreciation", { precision: 18, scale: 4 }).default("0").notNull(),
  disposedAt: timestamp("disposed_at"),
  disposalAmount: decimal("disposal_amount", { precision: 18, scale: 4 }),
  disposalJournalEntryId: integer("disposal_journal_entry_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.billId], foreignColumns: [purchaseBills.orgId, purchaseBills.id], name: "fk_acc_fixed_assets_bill_id_org" }),
  foreignKey({ columns: [table.orgId, table.categoryId], foreignColumns: [accAssetCategories.orgId, accAssetCategories.id], name: "fk_acc_fixed_assets_category_id_org" }),
  foreignKey({ columns: [table.orgId, table.disposalJournalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_acc_fixed_assets_disposal_journal_entry_id_org" }),
  unique("uniq_acc_fixed_assets_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_fixed_assets_org_number").on(table.orgId, table.assetNumber),
  index("idx_acc_fixed_assets_org_status").on(table.orgId, table.status),
  index("idx_acc_fixed_assets_org_category").on(table.orgId, table.categoryId),
]);

export const accDepreciationRuns = pgTable("acc_depreciation_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  periodKey: text("period_key").notNull(),
  status: accDepreciationRunStatusEnum("status").default("DRAFT").notNull(),
  totalAmount: decimal("total_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  journalEntryId: integer("journal_entry_id"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  postedAt: timestamp("posted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_acc_depreciation_runs_journal_entry_id_org" }),
  unique("uniq_acc_depreciation_runs_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_depreciation_runs_org_period").on(table.orgId, table.periodKey),
  index("idx_acc_depreciation_runs_org_status").on(table.orgId, table.status),
]);

export const accDepreciationSchedules = pgTable("acc_depreciation_schedules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  assetId: integer("asset_id").notNull(),
  periodKey: text("period_key").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  runId: integer("run_id"),
  journalEntryId: integer("journal_entry_id"),
  status: accDepreciationLineStatusEnum("status").default("SCHEDULED").notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.assetId], foreignColumns: [accFixedAssets.orgId, accFixedAssets.id], name: "fk_acc_depreciation_schedules_asset_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_acc_depreciation_schedules_journal_entry_id_org" }),
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [accDepreciationRuns.orgId, accDepreciationRuns.id], name: "fk_acc_depreciation_schedules_run_id_org" }),
  unique("uniq_acc_depreciation_sched_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_acc_depreciation_schedules_asset_period").on(table.assetId, table.periodKey),
  index("idx_acc_depreciation_schedules_org_asset").on(table.orgId, table.assetId),
  index("idx_acc_depreciation_schedules_run").on(table.runId),
]);

export const accAssetCategoriesRelations = relations(accAssetCategories, ({ one, many }) => ({
  organization: one(organizations, { fields: [accAssetCategories.orgId], references: [organizations.id] }),
  assetAccount: one(ledgerAccounts, { fields: [accAssetCategories.assetAccountId], references: [ledgerAccounts.id], relationName: "categoryAssetAccount" }),
  depreciationExpenseAccount: one(ledgerAccounts, { fields: [accAssetCategories.depreciationExpenseAccountId], references: [ledgerAccounts.id], relationName: "categoryDepExpAccount" }),
  accumulatedDepreciationAccount: one(ledgerAccounts, { fields: [accAssetCategories.accumulatedDepreciationAccountId], references: [ledgerAccounts.id], relationName: "categoryAccumDepAccount" }),
  assets: many(accFixedAssets),
}));

export const accFixedAssetsRelations = relations(accFixedAssets, ({ one, many }) => ({
  organization: one(organizations, { fields: [accFixedAssets.orgId], references: [organizations.id] }),
  category: one(accAssetCategories, { fields: [accFixedAssets.categoryId], references: [accAssetCategories.id] }),
  vendor: one(clients, { fields: [accFixedAssets.vendorId], references: [clients.id] }),
  bill: one(purchaseBills, { fields: [accFixedAssets.billId], references: [purchaseBills.id] }),
  disposalJournalEntry: one(journalEntries, { fields: [accFixedAssets.disposalJournalEntryId], references: [journalEntries.id] }),
  schedules: many(accDepreciationSchedules),
}));

export const accDepreciationRunsRelations = relations(accDepreciationRuns, ({ one, many }) => ({
  organization: one(organizations, { fields: [accDepreciationRuns.orgId], references: [organizations.id] }),
  journalEntry: one(journalEntries, { fields: [accDepreciationRuns.journalEntryId], references: [journalEntries.id] }),
  creator: one(users, { fields: [accDepreciationRuns.createdBy], references: [users.id] }),
  schedules: many(accDepreciationSchedules),
}));

export const accDepreciationSchedulesRelations = relations(accDepreciationSchedules, ({ one }) => ({
  organization: one(organizations, { fields: [accDepreciationSchedules.orgId], references: [organizations.id] }),
  asset: one(accFixedAssets, { fields: [accDepreciationSchedules.assetId], references: [accFixedAssets.id] }),
  run: one(accDepreciationRuns, { fields: [accDepreciationSchedules.runId], references: [accDepreciationRuns.id] }),
  journalEntry: one(journalEntries, { fields: [accDepreciationSchedules.journalEntryId], references: [journalEntries.id] }),
}));

