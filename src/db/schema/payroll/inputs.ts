import {
  pgTable, serial, text, integer, boolean, decimal, timestamp, index, uniqueIndex, unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { payrollInputSourceEnum } from "./enums";
import { payrollRuns } from "../hr/payroll-runs";

export const payrollInputs = pgTable("payroll_inputs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  source: payrollInputSourceEnum("source").notNull(),
  scheduledDays: decimal("scheduled_days", { precision: 6, scale: 2 }).notNull().default("0"),
  paidDays: decimal("paid_days", { precision: 6, scale: 2 }).notNull().default("0"),
  lopDays: decimal("lop_days", { precision: 6, scale: 2 }).notNull().default("0"),
  halfDays: decimal("half_days", { precision: 6, scale: 2 }).notNull().default("0"),
  overtimeHours: decimal("overtime_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  shiftAllowanceUnits: decimal("shift_allowance_units", { precision: 8, scale: 2 }).notNull().default("0"),
  holidayWorkDays: decimal("holiday_work_days", { precision: 6, scale: 2 }).notNull().default("0"),
  billableHours: decimal("billable_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  isOverride: boolean("is_override").notNull().default(false),
  overrideReason: text("override_reason"),
  overriddenBy: text("overridden_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payroll_inputs_org_id").on(table.orgId, table.id),
  index("idx_payroll_inputs_run").on(table.runId),
  index("idx_payroll_inputs_org_user").on(table.orgId, table.userId),
  uniqueIndex("uniq_payroll_inputs_run_user").on(table.runId, table.userId),
]);

export const payrollInputsRelations = relations(payrollInputs, ({ one }) => ({
  organization: one(organizations, { fields: [payrollInputs.orgId], references: [organizations.id] }),
  run: one(payrollRuns, { fields: [payrollInputs.runId], references: [payrollRuns.id] }),
  user: one(users, { fields: [payrollInputs.userId], references: [users.id] }),
  overriddenByUser: one(users, {
    fields: [payrollInputs.overriddenBy],
    references: [users.id],
    relationName: "payrollInputOverriddenBy",
  }),
}));
