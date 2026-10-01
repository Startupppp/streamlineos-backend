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
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "../build/core";
import { tickets } from "../build/tasks";
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
  userMembershipId: integer("user_membership_id"),
  ticketId: integer("ticket_id"),
  date: date("date").notNull(),
  hours: decimal("hours", { precision: 6, scale: 2 }).default("0").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  workLink: text("work_link"),
  status: timesheetEntryStatusEnum("status").default("PENDING").notNull(),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  isBillable: boolean("is_billable").default(false).notNull(),
  payrollStatus: timesheetPayrollStatusEnum("payroll_status").notNull().default("UNPROCESSED"),
  payrollExportId: integer("payroll_export_id"),
  projectId: integer("project_id"),
  timesheetPeriodId: integer("timesheet_period_id"),
  timerSessionId: integer("timer_session_id"),
  billingType: timesheetBillingTypeEnum("billing_type").notNull().default("BILLABLE"),
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }),
  costRate: decimal("cost_rate", { precision: 10, scale: 2 }),
  currency: text("currency"),
  rateSource: timesheetRateSourceEnum("rate_source"),
  invoicingStatus: timesheetInvoicingStatusEnum("invoicing_status").notNull().default("UNINVOICED"),
  submittedAt: timestamp("submitted_at"),
  lockedAt: timestamp("locked_at"),
  lockedByMembershipId: integer("locked_by_membership_id"),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
  source: timesheetEntrySourceEnum("source").notNull().default("MANUAL"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_timesheets_ticket_id_org" }),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_timesheets_project_id_org" }),
  foreignKey({ columns: [table.orgId, table.timesheetPeriodId], foreignColumns: [timesheetPeriods.orgId, timesheetPeriods.id], name: "fk_timesheets_timesheet_period_id_org" }),
  foreignKey({ columns: [table.orgId, table.timerSessionId], foreignColumns: [timerSessions.orgId, timerSessions.id], name: "fk_timesheets_timer_session_id_org" }),
  foreignKey({ columns: [table.orgId, table.payrollExportId], foreignColumns: [timesheetExports.orgId, timesheetExports.id], name: "fk_timesheets_payroll_export_id_org" }).onDelete("set null"),
  // Kept deliberately (BUG-TS-BE-007). uniq_timesheets_work_log leads on the
  // same three columns but is partial, so the planner can only use it for rows
  // satisfying its predicate. Every ticket-linked entry — the whole
  // Build-sourced half of the table — and every voided row fall outside it, and
  // the per-person-per-day range reads (entries list, period totals, the daily
  // cap check, the exception sweeps) must still find those. Not redundant.
  index("idx_timesheets_org_user_membership_date").on(table.orgId, table.userMembershipId, table.date),
  index("idx_timesheets_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheets_user_membership",
  }).onDelete("set null"),
  index("idx_timesheets_org_payroll").on(table.orgId, table.payrollStatus, table.date),
  index("idx_timesheets_org_project_date").on(table.orgId, table.projectId, table.date),
  index("idx_timesheets_org_invoicing").on(table.orgId, table.invoicingStatus),
  index("idx_timesheets_org_billing").on(table.orgId, table.isBillable, table.invoicingStatus),
  index("idx_timesheets_period").on(table.timesheetPeriodId),
  index("idx_timesheets_timer_session").on(table.timerSessionId),
  // One live work-log entry per person per day. Voided rows are excluded, or a
  // void would keep holding its day against the next entry (BUG-TS-BE-006).
  uniqueIndex("uniq_timesheets_work_log").on(table.orgId, table.userMembershipId, table.date).where(sql`ticket_id IS NULL AND voided_at IS NULL`),
  index("idx_timesheets_org_approved_actor").on(table.orgId, table.approvedByMembershipId),
  index("idx_timesheets_org_locked_by_membership").on(table.orgId, table.lockedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheets_approved_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.lockedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheets_locked_by_membership",
  }).onDelete("set null"),
]);
