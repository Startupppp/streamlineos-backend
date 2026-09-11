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
