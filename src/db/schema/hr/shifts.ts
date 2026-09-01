import { pgTable, text, serial, timestamp, boolean, time, integer, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";

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
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  shiftId: integer("shift_id").references(() => shiftTemplates.id, { onDelete: "cascade" }).notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_employee_shift_assignments_org_id").on(table.orgId, table.id),
  index("idx_shift_assignments_user").on(table.userId, table.isActive),
  index("idx_shift_assignments_org").on(table.orgId),
  index("idx_shift_assignments_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_shift_assignments_user_actor" }).onDelete("set null"),
]);

export const shiftSwapRequests = pgTable("shift_swap_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  requesterId: text("requester_id").notNull(),
  requesterMembershipId: integer("requester_membership_id"),
  targetUserId: text("target_user_id").notNull(),
  targetMembershipId: integer("target_membership_id"),
  requestDate: text("request_date").notNull(),
  targetDate: text("target_date").notNull(),
  reason: text("reason"),
  status: text("status").default("PENDING").notNull(),
  approverId: text("approver_id"),
  approverMembershipId: integer("approver_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_shift_swap_requests_org_id").on(table.orgId, table.id),
  index("idx_shift_swaps_org_status").on(table.orgId, table.status),
  index("idx_shift_swaps_requester").on(table.requesterId),
  index("idx_shift_swaps_org_requester_membership").on(table.orgId, table.requesterMembershipId),
  index("idx_shift_swaps_org_target_membership").on(table.orgId, table.targetMembershipId),
  index("idx_shift_swaps_org_approver_membership").on(table.orgId, table.approverMembershipId),
  foreignKey({ columns: [table.orgId, table.requesterMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_shift_swaps_requester_actor" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.targetMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_shift_swaps_target_actor" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.approverMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_shift_swaps_approver_actor" }).onDelete("set null"),
]);
