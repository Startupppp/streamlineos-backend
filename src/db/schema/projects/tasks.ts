import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, foreignKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  ticketTypeEnum,
  ticketPriorityEnum,
  workItemRelationTypeEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { projects, sprints, customStates, modules, cycles } from "./core";

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  type: ticketTypeEnum("type").default("TASK").notNull(),
  status: text("status").notNull().default("TODO"),
  priority: ticketPriorityEnum("priority").default("MEDIUM").notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  ticketNumber: integer("ticket_number").notNull(),
  sprintId: integer("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
  epicId: integer("epic_id"),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
  points: integer("points"),
  storyPoints: integer("story_points"),
  link: text("link"),
  order: integer("order").default(0).notNull(),
  parentTicketId: integer("parent_ticket_id"),
  originalEstimate: decimal("original_estimate", { precision: 10, scale: 2 }),
  timeSpent: decimal("time_spent", { precision: 10, scale: 2 }).default("0").notNull(),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  stateId: integer("state_id").references(() => customStates.id, { onDelete: "set null" }),
  moduleId: integer("module_id").references(() => modules.id, { onDelete: "set null" }),
  cycleId: integer("cycle_id").references(() => cycles.id, { onDelete: "set null" }),
  sequenceId: text("sequence_id"),
  estimate: integer("estimate"),
  completionPercentage: integer("completion_percentage").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.epicId], foreignColumns: [t.id] }).onDelete("set null"),
  foreignKey({ columns: [t.parentTicketId], foreignColumns: [t.id] }).onDelete("set null"),
  uniqueIndex("uniq_tickets_project_number").on(t.projectId, t.ticketNumber),
  index("idx_tickets_project_status").on(t.projectId, t.status),
  index("idx_tickets_assignee").on(t.assigneeId),
  index("idx_tickets_sprint").on(t.sprintId),
  index("idx_tickets_org_status_priority").on(t.orgId, t.status, t.priority),
]);

export const ticketAssignees = pgTable("ticket_assignees", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("uniq_ticket_assignees_ticket_user").on(table.ticketId, table.userId),
  index("idx_ticket_assignees_user_id").on(table.userId),
]);

export const ticketComments = pgTable("ticket_comments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  content: text("content").notNull(),
  parentCommentId: integer("parent_comment_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.parentCommentId], foreignColumns: [table.id] }).onDelete("cascade"),
  index("idx_ticket_comments_ticket").on(table.ticketId),
]);

export const ticketAttachments = pgTable("ticket_attachments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ticket_attachments_ticket").on(table.ticketId),
]);

export const ticketLabels = pgTable("ticket_labels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  color: text("color").default("#3B82F6").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_ticket_labels_org_name").on(table.orgId, table.name),
]);

export const ticketLabelMappings = pgTable("ticket_label_mappings", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  labelId: integer("label_id").references(() => ticketLabels.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_ticket_label_mappings_ticket_label").on(table.ticketId, table.labelId),
]);

export const ticketWatchers = pgTable("ticket_watchers", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_ticket_watcher").on(table.ticketId, table.userId),
  index("idx_ticket_watchers_user").on(table.userId),
]);

export const workItemRelations = pgTable("work_item_relations", {
  id: serial("id").primaryKey(),
  workItemId: integer("work_item_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  relatedWorkItemId: integer("related_work_item_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  relationType: workItemRelationTypeEnum("relation_type").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_work_item_relation").on(table.workItemId, table.relatedWorkItemId),
  index("idx_work_item_relations_item").on(table.workItemId),
  index("idx_work_item_relations_related").on(table.relatedWorkItemId),
]);

export const timesheets = pgTable("timesheets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  date: date("date").notNull(),
  hours: decimal("hours", { precision: 6, scale: 2 }).default("0").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  workLink: text("work_link"),
  status: text("status").default("PENDING").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  isBillable: boolean("is_billable").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_timesheets_user_date").on(table.userId, table.date),
  index("idx_timesheets_org_status").on(table.orgId, table.status),
  uniqueIndex("uniq_timesheets_work_log").on(table.orgId, table.userId, table.date).where(sql`ticket_id IS NULL`),
]);
