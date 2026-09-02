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
import { organizations, organizationMembers } from "../common/auth";
import { timesheetPeriodStatusEnum } from "./enums";

export const timesheetPeriods = pgTable("timesheet_periods", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userMembershipId: integer("user_membership_id"),
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
  currentApproverMembershipId: integer("current_approver_membership_id"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("uniq_timesheet_periods_user_membership_range").on(t.orgId, t.userMembershipId, t.periodStart, t.periodEnd),
  index("idx_timesheet_periods_org_user_membership").on(t.orgId, t.userMembershipId),
  foreignKey({
    columns: [t.orgId, t.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_periods_user_membership",
  }).onDelete("set null"),
  index("idx_timesheet_periods_current_approver_membership").on(t.orgId, t.currentApproverMembershipId),
  index("idx_timesheet_periods_org_approved_actor").on(t.orgId, t.approvedByMembershipId),
  foreignKey({
    columns: [t.orgId, t.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_periods_approved_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [t.orgId, t.currentApproverMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_periods_current_approver_membership",
  }).onDelete("set null"),
]);
