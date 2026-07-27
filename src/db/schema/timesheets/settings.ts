import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import {
  timesheetRoundingRuleEnum,
  timesheetApprovalModeEnum,
  timesheetPayPeriodEnum,
} from "./enums";

export const timesheetSettings = pgTable("timesheet_settings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  workWeekStart: integer("work_week_start").notNull().default(1),
  requiredFields: jsonb("required_fields"),
  roundingRule: timesheetRoundingRuleEnum("rounding_rule").notNull().default("NONE"),
  maxHoursPerDay: decimal("max_hours_per_day", { precision: 4, scale: 2 }).notNull().default("24"),
  allowOverlappingEntries: boolean("allow_overlapping_entries").notNull().default(true),
  allowBackdatedEntries: boolean("allow_backdated_entries").notNull().default(true),
  backdateLimitDays: integer("backdate_limit_days"),
  approvalMode: timesheetApprovalModeEnum("approval_mode").notNull().default("MANAGER"),
  clientApprovalEnabled: boolean("client_approval_enabled").notNull().default(false),
  lockAfterApproval: boolean("lock_after_approval").notNull().default(true),
  lockAfterInvoice: boolean("lock_after_invoice").notNull().default(true),
  reminderRules: jsonb("reminder_rules"),
  payPeriod: timesheetPayPeriodEnum("pay_period").notNull().default("MONTHLY"),
  overtimeDailyHours: decimal("overtime_daily_hours", { precision: 4, scale: 2 }).notNull().default("8"),
  overtimeWeeklyHours: decimal("overtime_weekly_hours", { precision: 5, scale: 2 }).notNull().default("40"),
  includeNonBillable: boolean("include_non_billable").notNull().default(true),
  payrollMapping: jsonb("payroll_mapping"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});
