import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { wfhRequestStatusEnum, ticketPriorityEnum, ticketStatusEnum, deviceStatusEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { workers } from "../directory/workers";
import { workerEngagements } from "../directory/worker-engagements";
import type { AttendanceRecordStatus } from "./attendance-status";

export const attendance = pgTable("attendance", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workerId: text("worker_id"),
  workerEngagementId: text("worker_engagement_id"),
  date: date("date").notNull(),
  checkIn: timestamp("check_in"),
  checkOut: timestamp("check_out"),
  status: text("status").$type<AttendanceRecordStatus>().default("PRESENT").notNull(),
  workHours: decimal("work_hours", { precision: 6, scale: 2 }),
  breakHours: decimal("break_hours", { precision: 6, scale: 2 }).default("0").notNull(),
  breaks: jsonb("breaks").$type<{ start: string; end?: string }[]>().default([]).notNull(),
  locationData: jsonb("location_data").$type<{ lat?: number; lng?: number; address?: string }>(),
  isOvertime: boolean("is_overtime").default(false).notNull(),
  autoCheckedOut: boolean("auto_checked_out").default(false).notNull(),
  locationVerified: boolean("location_verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_attendance_org_id").on(table.orgId, table.id),
  index("idx_attendance_org_date_status").on(table.orgId, table.date, table.status),
  index("idx_attendance_org_user_date").on(table.orgId, table.userId, table.date),
  index("idx_attendance_org_worker_date").on(table.orgId, table.workerId, table.date),
  index("idx_attendance_org_engagement_date").on(table.orgId, table.workerEngagementId, table.date),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_attendance_org_worker",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.workerId, table.workerEngagementId],
    foreignColumns: [
      workerEngagements.organizationId,
      workerEngagements.workerId,
      workerEngagements.workerEngagementId,
    ],
    name: "fk_attendance_worker_engagement",
  }).onDelete("restrict"),
  check(
    "chk_attendance_canonical_subject_pair",
    sql`(${table.workerId} IS NULL) = (${table.workerEngagementId} IS NULL)`,
  ),
  check(
    "chk_attendance_status",
    sql`${table.status} IN ('PRESENT', 'ON_BREAK', 'CHECKED_OUT', 'ABSENT', 'HALF_DAY', 'LATE', 'WFH', 'HALFDAY', 'HOLIDAY_WORK', 'LEAVE_WITHOUT_PAY')`,
  ),
]);

export const holidays = pgTable("holidays", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  date: date("date").notNull(),
  message: text("message"),
  isPublic: boolean("is_public").default(false).notNull(),
  notificationSent: boolean("notification_sent").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_holidays_org_id").on(table.orgId, table.id),
]);

export const wfhRequests = pgTable("wfh_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  date: date("date").notNull(),
  reason: text("reason"),
  status: wfhRequestStatusEnum("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id),
  approverMembershipId: integer("approver_membership_id"),
  userMembershipId: integer("user_membership_id"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_wfh_requests_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_wfh_requests_org_user_date").on(table.orgId, table.userId, table.date),
  index("idx_wfh_requests_org_status").on(table.orgId, table.status),
  index("idx_wfh_requests_org_user_status").on(table.orgId, table.userId, table.status),
  index("idx_wfh_requests_org_approver_membership").on(table.orgId, table.approverMembershipId),
  index("idx_wfh_requests_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.approverMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_wfh_requests_approver_actor",
  }).onDelete("restrict"),
]);

export const helpdeskTickets = pgTable("helpdesk_tickets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  priority: ticketPriorityEnum("priority").default("MEDIUM").notNull(),
  status: ticketStatusEnum("status").default("TODO").notNull(),
  assigneeId: text("assignee_id").references(() => users.id),
  assigneeMembershipId: integer("assignee_membership_id"),
  isConfidential: boolean("is_confidential").default(false).notNull(),
  slaDueAt: timestamp("sla_due_at"),
  resolvedAt: timestamp("resolved_at"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_helpdesk_tickets_org_id").on(table.orgId, table.id),
  index("idx_helpdesk_tickets_org_created").on(table.orgId, table.createdAt.desc(), table.id.desc()),
  index("idx_helpdesk_tickets_org_status_created").on(table.orgId, table.status, table.createdAt.desc(), table.id.desc()),
  index("idx_helpdesk_tickets_org_user_created").on(table.orgId, table.userId, table.createdAt.desc(), table.id.desc()),
  index("idx_helpdesk_tickets_org_assignee_created").on(table.orgId, table.assigneeId, table.createdAt.desc(), table.id.desc()),
  index("idx_helpdesk_tickets_org_assignee_membership").on(table.orgId, table.assigneeMembershipId),
  foreignKey({
    columns: [table.orgId, table.assigneeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_helpdesk_tickets_assignee_actor",
  }).onDelete("restrict"),
]);

export const hrHelpdeskRouting = pgTable("hr_helpdesk_routing", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  category: text("category").notNull(),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_helpdesk_routing_org_id").on(table.orgId, table.id),
  index("idx_hr_helpdesk_routing_org").on(table.orgId),
  uniqueIndex("uniq_helpdesk_routing_org_category").on(table.orgId, table.category),
]);

export const hrHelpdeskComments = pgTable("hr_helpdesk_comments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => helpdeskTickets.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_helpdesk_comments_org_id").on(table.orgId, table.id),
  index("idx_hr_helpdesk_comments_ticket").on(table.ticketId),
]);

export const employeeDevices = pgTable("employee_devices", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  deviceType: text("device_type").notNull(),
  deviceName: text("device_name").notNull(),
  serialNumber: text("serial_number"),
  brand: text("brand"),
  model: text("model"),
  assignedDate: date("assigned_date"),
  returnDate: date("return_date"),
  status: deviceStatusEnum("status").default("ACTIVE").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_employee_devices_org_id").on(table.orgId, table.id),
  index("idx_employee_devices_org_user").on(table.orgId, table.userId),
]);

export const holidaysRelations = relations(holidays, ({ one }) => ({
  organization: one(organizations, { fields: [holidays.orgId], references: [organizations.id] }),
}));

export const wfhRequestsRelations = relations(wfhRequests, ({ one }) => ({
  user: one(users, { fields: [wfhRequests.userId], references: [users.id] }),
  approver: one(users, { fields: [wfhRequests.approverId], references: [users.id], relationName: "wfhApprover" }),
}));

export const employeeDevicesRelations = relations(employeeDevices, ({ one }) => ({
  user: one(users, { fields: [employeeDevices.userId], references: [users.id] }),
}));

export const helpdeskTicketsRelations = relations(helpdeskTickets, ({ one, many }) => ({
  user: one(users, { fields: [helpdeskTickets.userId], references: [users.id] }),
  assignee: one(users, { fields: [helpdeskTickets.assigneeId], references: [users.id], relationName: "helpdeskAssignee" }),
  comments: many(hrHelpdeskComments),
}));

export const hrHelpdeskCommentsRelations = relations(hrHelpdeskComments, ({ one }) => ({
  ticket: one(helpdeskTickets, { fields: [hrHelpdeskComments.ticketId], references: [helpdeskTickets.id] }),
  author: one(users, { fields: [hrHelpdeskComments.authorId], references: [users.id] }),
}));

export const hrHelpdeskRoutingRelations = relations(hrHelpdeskRouting, ({ one }) => ({
  assignee: one(users, { fields: [hrHelpdeskRouting.assigneeUserId], references: [users.id] }),
}));
