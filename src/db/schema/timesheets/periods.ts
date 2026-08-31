import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  decimal,
  date,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";
import { timesheetPeriodStatusEnum } from "./enums";

export const timesheetPeriods = pgTable("timesheet_periods", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: timesheetPeriodStatusEnum("status").notNull().default("OPEN"),
  totalHours: decimal("total_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  billableHours: decimal("billable_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  nonBillableHours: decimal("non_billable_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  submittedAt: timestamp("submitted_at"),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  lockedAt: timestamp("locked_at"),
  currentApproverId: text("current_approver_id").references(() => users.id, { onDelete: "set null" }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedByMembershipId: integer("approved_by_membership_id"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("uniq_timesheet_periods_user_range").on(t.orgId, t.userId, t.periodStart, t.periodEnd),
  index("idx_timesheet_periods_user_start").on(t.orgId, t.userId, t.periodStart),
  index("idx_timesheet_periods_org_status").on(t.orgId, t.status, t.submittedAt),
  index("idx_timesheet_periods_current_approver").on(t.orgId, t.currentApproverId),
  index("idx_timesheet_periods_org_approved_actor").on(t.orgId, t.approvedByMembershipId),
  foreignKey({
    columns: [t.orgId, t.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_periods_approved_actor",
  }).onDelete("restrict"),
]);
