import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  timesheetRoundingRuleEnum,
  timesheetApprovalModeEnum,
  timesheetPayPeriodEnum,
} from "./enums";
import { sql } from "drizzle-orm";
import { date } from "drizzle-orm/pg-core";
import { organizations, users } from "../common";

export const timesheetExports = pgTable(
  "timesheet_exports",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    exportType: text("export_type").notNull().default("PAYROLL"),
    status: text("status").notNull().default("COMPLETED"),
    dateRangeStart: date("date_range_start").notNull(),
    dateRangeEnd: date("date_range_end").notNull(),
    format: text("format").notNull(),
    filters: jsonb("filters").$type<object>(),
    snapshot: jsonb("snapshot").$type<object>().notNull(),
    entryCount: integer("entry_count").notNull().default(0),
    totalHours: decimal("total_hours", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    fileUrl: text("file_url"),
    note: text("note"),
    idempotencyKey: text("idempotency_key"),
    ackStatus: text("ack_status"),
    ackNote: text("ack_note"),
    ackAt: timestamp("ack_at"),
    ackBy: text("ack_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_timesheet_exports_org_type_created").on(
      table.orgId,
      table.exportType,
      table.createdAt,
    ),
    uniqueIndex("uniq_timesheet_exports_idem")
      .on(table.orgId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

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
