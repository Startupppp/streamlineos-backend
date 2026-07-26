import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../auth";
import { projects } from "../projects/core";
import { tickets } from "../projects/tasks";
import { timesheetPeriods } from "./periods";
import { timerSessions } from "./timer";
import { timesheetExports } from "./exports";
import {
  timesheetEntryStatusEnum,
  timesheetPayrollStatusEnum,
  timesheetBillingTypeEnum,
  timesheetInvoicingStatusEnum,
  timesheetRateSourceEnum,
  timesheetEntrySourceEnum,
} from "./enums";

export const timesheets = pgTable("timesheets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  date: date("date").notNull(),
  hours: decimal("hours", { precision: 6, scale: 2 }).default("0").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  workLink: text("work_link"),
  status: timesheetEntryStatusEnum("status").default("PENDING").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  isBillable: boolean("is_billable").default(false).notNull(),
  payrollStatus: timesheetPayrollStatusEnum("payroll_status").notNull().default("UNPROCESSED"),
  payrollExportId: integer("payroll_export_id").references(() => timesheetExports.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  timesheetPeriodId: integer("timesheet_period_id").references(() => timesheetPeriods.id, { onDelete: "set null" }),
  timerSessionId: integer("timer_session_id").references(() => timerSessions.id, { onDelete: "set null" }),
  billingType: timesheetBillingTypeEnum("billing_type").notNull().default("BILLABLE"),
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }),
  costRate: decimal("cost_rate", { precision: 10, scale: 2 }),
  currency: text("currency"),
  rateSource: timesheetRateSourceEnum("rate_source"),
  invoicingStatus: timesheetInvoicingStatusEnum("invoicing_status").notNull().default("UNINVOICED"),
  submittedAt: timestamp("submitted_at"),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
  source: timesheetEntrySourceEnum("source").notNull().default("MANUAL"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_timesheets_org_user_date").on(table.orgId, table.userId, table.date),
  index("idx_timesheets_org_status").on(table.orgId, table.status),
  index("idx_timesheets_org_payroll").on(table.orgId, table.payrollStatus, table.date),
  index("idx_timesheets_org_project_date").on(table.orgId, table.projectId, table.date),
  index("idx_timesheets_org_invoicing").on(table.orgId, table.invoicingStatus),
  index("idx_timesheets_org_billing").on(table.orgId, table.isBillable, table.invoicingStatus),
  index("idx_timesheets_period").on(table.timesheetPeriodId),
  index("idx_timesheets_timer_session").on(table.timerSessionId),
  uniqueIndex("uniq_timesheets_work_log").on(table.orgId, table.userId, table.date).where(sql`ticket_id IS NULL`),
]);
