import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, uniqueIndex, unique, check, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { leaveStatusEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { workerEngagements } from "../directory/worker-engagements";
import { workers } from "../directory/workers";

type LeaveRequestPriority = "LOW" | "MEDIUM" | "HIGH";
type LeaveHalfDayPeriod = "AM" | "PM";

export const leaveTypes = pgTable("leave_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  daysPerYear: integer("days_per_year").notNull(),
  carryForward: boolean("carry_forward").default(false).notNull(),
}, (table) => [
  unique("uniq_leave_types_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_leave_types_org_name").on(table.orgId, table.name),
]);

export const leaveBalances = pgTable("leave_balances", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id, { onDelete: "cascade" }).notNull(),
  balance: decimal("balance", { precision: 6, scale: 2 }).default("0").notNull(),
  year: integer("year").notNull(),
}, (table) => [
  unique("uniq_leave_balances_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_leave_balances_user_type_year").on(table.userId, table.leaveTypeId, table.year),
  index("idx_leave_balances_org_year").on(table.orgId, table.year),
  check("chk_leave_balance_non_negative", sql`${table.balance} >= 0`),
]);

export const leaveRequests = pgTable("leave_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  // Stable display/delivery identity. Membership columns carry tenant authority.
  userId: text("user_id").notNull(),
  workerId: text("worker_id"),
  workerEngagementId: text("worker_engagement_id"),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id, { onDelete: "restrict" }).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason"),
  priority: text("priority").$type<LeaveRequestPriority>().default("MEDIUM").notNull(),
  status: leaveStatusEnum("status").default("PENDING").notNull(),
  approverId: text("approver_id"),
  rejectionReason: text("rejection_reason"),
  managerComment: text("manager_comment"),
  attachmentUrl: text("attachment_url"),
  isHalfDay: boolean("is_half_day").default(false).notNull(),
  halfDayPeriod: text("half_day_period").$type<LeaveHalfDayPeriod>(),
  coveringEmployeeId: text("covering_employee_id"),
  lopDays: decimal("lop_days", { precision: 5, scale: 1 }).default("0").notNull(),
  approverMembershipId: integer("approver_membership_id"),
  userMembershipId: integer("user_membership_id"),
  coveringEmployeeMembershipId: integer("covering_employee_membership_id"),
  rowVersion: integer("row_version").default(1).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  updatedByMembershipId: integer("updated_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("uniq_leave_requests_org_id").on(table.orgId, table.id),
  index("idx_leave_requests_user_id").on(table.userId),
  index("idx_leave_requests_org_user_membership").on(table.orgId, table.userMembershipId),
  index("idx_leave_requests_org_covering_membership").on(table.orgId, table.coveringEmployeeMembershipId),
  index("idx_leave_requests_org_status").on(table.orgId, table.status),
  index("idx_leave_requests_dates").on(table.startDate, table.endDate),
  index("idx_leave_requests_org_user_status").on(table.orgId, table.userId, table.status),
  index("idx_leave_requests_org_created").on(table.orgId, table.createdAt),
  index("idx_leave_requests_org_approver").on(table.orgId, table.approverId),
  index("idx_leave_requests_org_approver_membership").on(table.orgId, table.approverMembershipId),
  index("idx_leave_requests_org_worker").on(table.orgId, table.workerId),
  index("idx_leave_requests_org_engagement").on(
    table.orgId,
    table.workerEngagementId,
  ),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_leave_requests_user_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.coveringEmployeeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_leave_requests_covering_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_leave_requests_org_worker",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.workerId, table.workerEngagementId],
    foreignColumns: [
      workerEngagements.organizationId,
      workerEngagements.workerId,
      workerEngagements.workerEngagementId,
    ],
    name: "fk_leave_requests_worker_engagement",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.approverMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_leave_requests_approver_actor",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_leave_requests_created_actor",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_leave_requests_updated_actor",
  }).onDelete("restrict"),
  check("chk_leave_requests_row_version", sql`${table.rowVersion} > 0`),
  check(
    "chk_leave_requests_priority",
    sql`${table.priority} IN ('LOW', 'MEDIUM', 'HIGH')`,
  ),
  check(
    "chk_leave_requests_half_day_period",
    sql`${table.halfDayPeriod} IS NULL OR ${table.halfDayPeriod} IN ('AM', 'PM')`,
  ),
  check(
    "chk_leave_requests_canonical_subject_pair",
    sql`(${table.workerId} IS NULL) = (${table.workerEngagementId} IS NULL)`,
  ),
]);

export const leaveBlackoutDates = pgTable("leave_blackout_dates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason").notNull(),
  appliesTo: text("applies_to").notNull().default("ALL"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_leave_blackout_dates_org_id").on(table.orgId, table.id),
  index("idx_leave_blackout_org").on(table.orgId, table.startDate),
  check(
    "chk_leave_blackout_dates_applies_to",
    sql`length(btrim(${table.appliesTo})) > 0`,
  ),
]);

export const leaveRequestsRelations = relations(leaveRequests, ({ one }) => ({
  user: one(users, { fields: [leaveRequests.userId], references: [users.id] }),
  leaveType: one(leaveTypes, { fields: [leaveRequests.leaveTypeId], references: [leaveTypes.id] }),
  approver: one(users, { fields: [leaveRequests.approverId], references: [users.id], relationName: "leaveApprover" }),
  coveringEmployee: one(users, { fields: [leaveRequests.coveringEmployeeId], references: [users.id], relationName: "leaveCoveringEmployee" }),
}));

export const leaveBalancesRelations = relations(leaveBalances, ({ one }) => ({
  leaveType: one(leaveTypes, { fields: [leaveBalances.leaveTypeId], references: [leaveTypes.id] }),
}));

export const leaveBlackoutDatesRelations = relations(leaveBlackoutDates, ({ one }) => ({
  organization: one(organizations, { fields: [leaveBlackoutDates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [leaveBlackoutDates.createdBy], references: [users.id] }),
}));
