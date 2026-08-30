import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  integer,
  jsonb,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import {
  timesheetRoundingRuleEnum,
  timesheetApprovalModeEnum,
  timesheetPayPeriodEnum,
} from "./enums";
import { organizations, users, organizationMembers } from "../common";

export const timesheetSettingsHistory = pgTable("timesheet_settings_history", {
  id: serial("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  settings: jsonb("settings").notNull(),
  changedBy: text("changed_by").references(() => users.id, { onDelete: "set null" }),
  changedByMembershipId: integer("changed_by_membership_id"),
  changeReason: text("change_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uniq_ts_settings_history_version").on(t.orgId, t.version),
  foreignKey({
    columns: [t.orgId, t.changedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_ts_settings_history_changed_by_membership",
  }).onDelete("set null"),
]);

export const timesheetSettings = pgTable("timesheet_settings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  workWeekStart: integer("work_week_start").notNull().default(1),
  requiredFields: jsonb("required_fields"),
  roundingRule: timesheetRoundingRuleEnum("rounding_rule")
    .notNull()
    .default("NONE"),
  maxHoursPerDay: decimal("max_hours_per_day", { precision: 4, scale: 2 })
    .notNull()
    .default("24"),
  allowOverlappingEntries: boolean("allow_overlapping_entries")
    .notNull()
    .default(true),
  allowBackdatedEntries: boolean("allow_backdated_entries")
    .notNull()
    .default(true),
  backdateLimitDays: integer("backdate_limit_days"),
  approvalMode: timesheetApprovalModeEnum("approval_mode")
    .notNull()
    .default("MANAGER"),
  clientApprovalEnabled: boolean("client_approval_enabled")
    .notNull()
    .default(false),
  lockAfterApproval: boolean("lock_after_approval").notNull().default(true),
  lockAfterInvoice: boolean("lock_after_invoice").notNull().default(true),
  reminderRules: jsonb("reminder_rules"),
  payPeriod: timesheetPayPeriodEnum("pay_period").notNull().default("MONTHLY"),
  allowFutureEntries: boolean("allow_future_entries").notNull().default(false),
  expectedDailyHours: decimal("expected_daily_hours", {
    precision: 4,
    scale: 2,
  }),
  expectedWeeklyHours: decimal("expected_weekly_hours", {
    precision: 5,
    scale: 2,
  }),
  submissionGraceDays: integer("submission_grace_days"),
  overtimeDailyHours: decimal("overtime_daily_hours", {
    precision: 4,
    scale: 2,
  })
    .notNull()
    .default("8"),
  overtimeWeeklyHours: decimal("overtime_weekly_hours", {
    precision: 5,
    scale: 2,
  })
    .notNull()
    .default("40"),
  includeNonBillable: boolean("include_non_billable").notNull().default(true),
  payrollMapping: jsonb("payroll_mapping"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
