import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  payslipLayoutEnum,
  payrollBankBatchStatusEnum, payrollBankItemStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { payrollRuns, payrollRunEmployees } from "./payroll-runs";

export const payslipTemplates = pgTable("payslip_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  layout: payslipLayoutEnum("layout").notNull(),
  config: jsonb("config").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payslip_templates_org_id").on(table.orgId, table.id),
  index("idx_payslip_templates_org").on(table.orgId),
]);

export const payrollBankBatches = pgTable("payroll_bank_batches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  batchNumber: text("batch_number").notNull(),
  status: payrollBankBatchStatusEnum("status").default("DRAFT").notNull(),
  format: text("format").notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
  itemCount: integer("item_count").default(0).notNull(),
  idempotencyKey: text("idempotency_key"),
  fileKey: text("file_key"),
  generatedBy: text("generated_by").references(() => users.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payroll_bank_batches_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_bank_batches_org_number").on(table.orgId, table.batchNumber),
  uniqueIndex("uniq_payroll_bank_batches_org_idempotency_key").on(table.orgId, table.idempotencyKey),
  index("idx_payroll_bank_batches_org_run").on(table.orgId, table.runId),
]);

export const payrollBankBatchItems = pgTable("payroll_bank_batch_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  batchId: integer("batch_id").references(() => payrollBankBatches.id, { onDelete: "cascade" }).notNull(),
  runEmployeeId: integer("run_employee_id").references(() => payrollRunEmployees.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  accountMasked: text("account_masked").notNull(),
  ifsc: text("ifsc"),
  status: payrollBankItemStatusEnum("status").default("PENDING").notNull(),
  failureReason: text("failure_reason"),
  transactionRef: text("transaction_ref"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payroll_bank_batch_items_org_id").on(table.orgId, table.id),
  index("idx_payroll_bank_batch_items_batch_status").on(table.batchId, table.status),
  index("idx_payroll_bank_batch_items_org").on(table.orgId),
]);

export const payslipTemplatesRelations = relations(payslipTemplates, ({ one }) => ({
  org: one(organizations, { fields: [payslipTemplates.orgId], references: [organizations.id] }),
}));

export const payrollBankBatchesRelations = relations(payrollBankBatches, ({ one, many }) => ({
  run: one(payrollRuns, { fields: [payrollBankBatches.runId], references: [payrollRuns.id] }),
  items: many(payrollBankBatchItems),
  generatedByUser: one(users, { fields: [payrollBankBatches.generatedBy], references: [users.id], relationName: "batchGeneratedBy" }),
}));

export const payrollBankBatchItemsRelations = relations(payrollBankBatchItems, ({ one }) => ({
  batch: one(payrollBankBatches, { fields: [payrollBankBatchItems.batchId], references: [payrollBankBatches.id] }),
  runEmployee: one(payrollRunEmployees, { fields: [payrollBankBatchItems.runEmployeeId], references: [payrollRunEmployees.id] }),
  user: one(users, { fields: [payrollBankBatchItems.userId], references: [users.id] }),
}));
