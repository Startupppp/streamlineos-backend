import {
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  date,
  jsonb,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { cycles, projects, sprints } from "./core";
import { tickets } from "./tasks";

export const meetingTypeEnum = pgEnum("meeting_type", ["meeting", "standup", "retro", "planning", "review"]);
export const projectMeetingStatusEnum = pgEnum("project_meeting_status", ["scheduled", "in_progress", "completed", "cancelled"]);
export const actionItemStatusEnum = pgEnum("action_item_status", ["open", "in_progress", "done", "converted", "cancelled"]);

export const projectMeetings = build.table("project_meetings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
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
  sprintId: integer("sprint_id"),
  cycleId: integer("cycle_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_meetings_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.sprintId], foreignColumns: [sprints.orgId, sprints.id], name: "fk_project_meetings_org_sprint" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.cycleId], foreignColumns: [cycles.orgId, cycles.id], name: "fk_project_meetings_org_cycle" }).onDelete("set null"),
  index("idx_project_meetings_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  index("idx_project_meetings_cycle").on(t.cycleId),
  uniqueIndex("uq_project_meetings_project_number").on(t.projectId, t.meetingNumber),
  index("idx_project_meetings_scheduled").on(t.scheduledAt),
  unique("uniq_project_meetings_org_id").on(t.orgId, t.id),
]);

export const meetingAttendees = build.table("meeting_attendees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").notNull(),
  membershipId: integer("membership_id").notNull(),
  attended: boolean("attended").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.meetingId], foreignColumns: [projectMeetings.orgId, projectMeetings.id], name: "fk_meeting_attendees_org_meeting" }).onDelete("cascade"),
  uniqueIndex("uq_meeting_attendees_meeting_user").on(t.meetingId, t.membershipId),
  index("idx_meeting_attendees_org_membership").on(t.orgId, t.membershipId),
  unique("uniq_meeting_attendees_org_id").on(t.orgId, t.id),
  foreignKey({
    name: "fk_meeting_attendees_actor",
    columns: [t.orgId, t.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const meetingActionItems = build.table("meeting_action_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").notNull(),
  projectId: integer("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  status: actionItemStatusEnum("status").notNull().default("open"),
  convertedTicketId: integer("converted_ticket_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.meetingId], foreignColumns: [projectMeetings.orgId, projectMeetings.id], name: "fk_meeting_action_items_org_meeting" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_meeting_action_items_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.convertedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_meeting_action_items_org_ticket" }).onDelete("set null"),
  index("idx_meeting_action_items_meeting").on(t.meetingId),
  index("idx_meeting_action_items_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  index("idx_meeting_action_items_assignee").on(t.assigneeId),
  unique("uniq_meeting_action_items_org_id").on(t.orgId, t.id),
]);

export const meetingStandupEntries = build.table("meeting_standup_entries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  meetingId: integer("meeting_id").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  membershipId: integer("membership_id"),
  yesterday: text("yesterday"),
  today: text("today"),
  blockers: text("blockers"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.meetingId], foreignColumns: [projectMeetings.orgId, projectMeetings.id], name: "fk_meeting_standup_entries_org_meeting" }).onDelete("cascade"),
  uniqueIndex("uq_meeting_standup_meeting_user").on(t.meetingId, t.userId),
  index("idx_meeting_standup_entries_org_membership").on(t.orgId, t.membershipId),
  unique("uniq_meeting_standup_entries_org_id").on(t.orgId, t.id),
  foreignKey({
    name: "fk_meeting_standup_entries_actor",
    columns: [t.orgId, t.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);
