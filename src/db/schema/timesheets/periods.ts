import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  decimal,
  date,
  index,
  jsonb,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { timesheetPeriodStatusEnum } from "./enums";

export interface TimesheetApprovalRoute {
  source: "reporting_manager" | "project_manager" | "auto";
  rung: string | null;
  approverUserId: string | null;
  approverMembershipId: number | null;
  assignedToUserId: string | null;
  delegation: { fromUserId: string; toUserId: string; endsAt: string } | null;
  projectId: number | null;
  explanation: string;
  slaHours: number;
  escalationRung: string | null;
  escalatedFrom: { approverUserId: string | null; rung: string | null; at: string } | null;
}

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
  approvalRoute: jsonb("approval_route").$type<TimesheetApprovalRoute>(),
  approvalDueAt: timestamp("approval_due_at"),
  approvalEscalatedAt: timestamp("approval_escalated_at"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  rejectionReason: text("rejection_reason"),
  /**
   * Monotonic lifecycle counter, used as `aggregate_version` on every outbox
   * event this period emits (TS-05).
   *
   * `outbox_events` is UNIQUE on `(organization_id, aggregate_type,
   * aggregate_id, aggregate_version)`. A period emits repeatedly — submitted,
   * approved or rejected, locked, then all of it again after a reopen — so a
   * constant version works exactly once and then fails every subsequent
   * transition for that period, forever. A wall-clock version would collide
   * whenever two transitions share a millisecond, which approve-and-lock does
   * by construction: one transaction, one `now`, two events.
   *
   * Incremented with `event_seq + 1` inside the same UPDATE that changes the
   * status, so the counter and the transition commit together and two
   * concurrent transitions serialise on the row rather than racing.
   */
  eventSeq: integer("event_seq").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("uniq_timesheet_periods_user_membership_range").on(t.orgId, t.userMembershipId, t.periodStart, t.periodEnd),
  index("idx_timesheet_periods_org_user_membership").on(t.orgId, t.userMembershipId),
  index("idx_ts_periods_org_status_submitted").on(t.orgId, t.status, t.submittedAt.desc(), t.id.desc()),
  foreignKey({
    columns: [t.orgId, t.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_periods_user_membership",
  }).onDelete("set null"),
  index("idx_timesheet_periods_current_approver_membership").on(t.orgId, t.currentApproverMembershipId),
  index("idx_timesheet_periods_org_awaiting_decision").on(t.orgId, t.approvalDueAt).where(sql`${t.status} = 'SUBMITTED'`),
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
