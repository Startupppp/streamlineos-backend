import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { leaveStatusEnum } from "../enums";
import { organizations, users } from "../auth";

export const leaveTypes = pgTable("leave_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  daysPerYear: integer("days_per_year").notNull(),
  carryForward: boolean("carry_forward").default(false).notNull(),
}, (table) => [
  uniqueIndex("uniq_leave_types_org_name").on(table.orgId, table.name),
]);

export const leaveBalances = pgTable("leave_balances", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id, { onDelete: "cascade" }).notNull(),
  balance: decimal("balance", { precision: 6, scale: 2 }).default("0").notNull(),
  year: integer("year").notNull(),
}, (table) => [
  uniqueIndex("uniq_leave_balances_user_type_year").on(table.userId, table.leaveTypeId, table.year),
  index("idx_leave_balances_org_year").on(table.orgId, table.year),
  check("chk_leave_balance_non_negative", sql`${table.balance} >= 0`),
]);

export const leaveRequests = pgTable("leave_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id, { onDelete: "restrict" }).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason"),
  priority: text("priority").default("MEDIUM").notNull(),
  status: leaveStatusEnum("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id, { onDelete: "set null" }),
  rejectionReason: text("rejection_reason"),
  managerComment: text("manager_comment"),
  attachmentUrl: text("attachment_url"),
  isHalfDay: boolean("is_half_day").default(false).notNull(),
  halfDayPeriod: text("half_day_period"),
  coveringEmployeeId: text("covering_employee_id").references(() => users.id, { onDelete: "set null" }),
  lopDays: decimal("lop_days", { precision: 5, scale: 1 }).default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_leave_requests_user_id").on(table.userId),
  index("idx_leave_requests_org_status").on(table.orgId, table.status),
  index("idx_leave_requests_dates").on(table.startDate, table.endDate),
  index("idx_leave_requests_org_user_status").on(table.orgId, table.userId, table.status),
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
  index("idx_leave_blackout_org").on(table.orgId, table.startDate),
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
