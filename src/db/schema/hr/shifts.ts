import { pgTable, text, serial, timestamp, boolean, time, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const shiftTemplates = pgTable("shift_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("FIXED"),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  breakMinutes: integer("break_minutes").default(60).notNull(),
  isNightShift: boolean("is_night_shift").default(false).notNull(),
  gracePeriodMinutes: integer("grace_period_minutes").default(15).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_shift_templates_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_shift_templates_org_name").on(table.orgId, table.name),
  index("idx_shift_templates_org_active").on(table.orgId, table.isActive),
]);

export const employeeShiftAssignments = pgTable("employee_shift_assignments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  shiftId: integer("shift_id").references(() => shiftTemplates.id, { onDelete: "cascade" }).notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_employee_shift_assignments_org_id").on(table.orgId, table.id),
  index("idx_shift_assignments_user").on(table.userId, table.isActive),
  index("idx_shift_assignments_org").on(table.orgId),
]);

export const shiftSwapRequests = pgTable("shift_swap_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  requesterId: text("requester_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  targetUserId: text("target_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  requestDate: text("request_date").notNull(),
  targetDate: text("target_date").notNull(),
  reason: text("reason"),
  status: text("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_shift_swap_requests_org_id").on(table.orgId, table.id),
  index("idx_shift_swaps_org_status").on(table.orgId, table.status),
  index("idx_shift_swaps_requester").on(table.requesterId),
]);
