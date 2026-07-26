import { pgTable, pgEnum, text, serial, timestamp, integer, boolean, date, jsonb, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects, sprints } from "./core";
import { tickets } from "./tasks";

export const meetingTypeEnum = pgEnum("meeting_type", ["meeting", "standup", "retro", "planning", "review"]);
export const projectMeetingStatusEnum = pgEnum("project_meeting_status", ["scheduled", "in_progress", "completed", "cancelled"]);
export const actionItemStatusEnum = pgEnum("action_item_status", ["open", "in_progress", "done", "converted", "cancelled"]);

export const projectMeetings = pgTable("project_meetings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  meetingNumber: integer("meeting_number").notNull(),
  title: text("title").notNull(),
  type: meetingTypeEnum("type").notNull().default("meeting"),
  status: projectMeetingStatusEnum("status").notNull().default("scheduled"),
  agenda: text("agenda"),
  notes: text("notes"),
  scheduledAt: timestamp("scheduled_at"),
  endAt: timestamp("end_at"),
  durationMinutes: integer("duration_minutes"),
  timezone: text("timezone"),
  recurrenceRule: jsonb("recurrence_rule"),
  sprintId: integer("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_meetings_org_project_status").on(t.orgId, t.projectId, t.status),
  uniqueIndex("uq_project_meetings_project_number").on(t.projectId, t.meetingNumber),
  index("idx_project_meetings_scheduled").on(t.scheduledAt),
  unique("uniq_project_meetings_org_id").on(t.orgId, t.id),
]);

export const meetingAttendees = pgTable("meeting_attendees", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").references(() => projectMeetings.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  attended: boolean("attended").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uq_meeting_attendees_meeting_user").on(t.meetingId, t.userId),
  index("idx_meeting_attendees_user").on(t.userId),
  unique("uniq_meeting_attendees_org_id").on(t.orgId, t.id),
]);

export const meetingActionItems = pgTable("meeting_action_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").references(() => projectMeetings.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  status: actionItemStatusEnum("status").notNull().default("open"),
  convertedTicketId: integer("converted_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_meeting_action_items_meeting").on(t.meetingId),
  index("idx_meeting_action_items_org_project_status").on(t.orgId, t.projectId, t.status),
  index("idx_meeting_action_items_assignee").on(t.assigneeId),
  unique("uniq_meeting_action_items_org_id").on(t.orgId, t.id),
]);

export const meetingStandupEntries = pgTable("meeting_standup_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").references(() => projectMeetings.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  yesterday: text("yesterday"),
  today: text("today"),
  blockers: text("blockers"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("uq_meeting_standup_meeting_user").on(t.meetingId, t.userId),
  unique("uniq_meeting_standup_entries_org_id").on(t.orgId, t.id),
]);
