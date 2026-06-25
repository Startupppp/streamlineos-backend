import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { wfhRequestStatusEnum, ticketPriorityEnum, ticketStatusEnum, deviceStatusEnum } from "../enums";
import { organizations, users } from "../auth";

export const attendance = pgTable("attendance", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  checkIn: timestamp("check_in"),
  checkOut: timestamp("check_out"),
  status: text("status").default("PRESENT").notNull(),
  workHours: decimal("work_hours", { precision: 6, scale: 2 }),
  breakHours: decimal("break_hours", { precision: 6, scale: 2 }).default("0").notNull(),
  breaks: jsonb("breaks").$type<{ start: string; end?: string }[]>().default([]).notNull(),
  locationData: jsonb("location_data").$type<{ lat?: number; lng?: number; address?: string }>(),
  isOvertime: boolean("is_overtime").default(false).notNull(),
  autoCheckedOut: boolean("auto_checked_out").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_attendance_user_date").on(table.userId, table.date),
  index("idx_attendance_org_date_status").on(table.orgId, table.date, table.status),
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
});

export const wfhRequests = pgTable("wfh_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  date: date("date").notNull(),
  reason: text("reason"),
  status: wfhRequestStatusEnum("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_wfh_requests_user_date").on(table.userId, table.date),
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
  resolvedAt: timestamp("resolved_at"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

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
});

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
