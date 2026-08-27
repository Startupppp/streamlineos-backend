import { pgTable, text, serial, timestamp, boolean, jsonb, date, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  leadEmailDirectionEnum, leadTaskStatusEnum, scoringOperatorEnum,
  assignmentRuleTypeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";

export const leadActivities = pgTable("lead_activities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leadId: integer("lead_id").notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  type: text("type").notNull(),
  date: timestamp("date").notNull(),
  duration: integer("duration"),
  subject: text("subject"),
  location: text("location"),
  locationLink: text("location_link"),
  messageSummary: text("message_summary"),
  notes: text("notes"),
  outcome: text("outcome"),
  userId: text("user_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_activities_lead").on(table.leadId),
  index("idx_lead_activities_user").on(table.userId),
  index("idx_lead_activities_org_date").on(table.orgId, table.date),
  unique("uniq_lead_activities_org_id").on(table.orgId, table.id),
]);

export const leadNotes = pgTable("lead_notes", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  authorId: text("author_id").references(() => users.id).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_notes_lead").on(table.leadId),
  index("idx_lead_notes_org_created").on(table.orgId, table.createdAt),
  unique("uniq_lead_notes_org_id").on(table.orgId, table.id),
]);

export const leadTasks = pgTable("lead_tasks", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  dueDate: date("due_date"),
  assigneeId: text("assignee_id").references(() => users.id),
  status: leadTaskStatusEnum("status").default("open").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_tasks_lead").on(table.leadId),
  index("idx_lead_tasks_org_status").on(table.orgId, table.status),
  unique("uniq_lead_tasks_org_id").on(table.orgId, table.id),
]);

export const leadEmails = pgTable("lead_emails", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  direction: leadEmailDirectionEnum("direction").notNull(),
  subject: text("subject"),
  body: text("body"),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  messageId: text("message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_emails_lead").on(table.leadId),
  index("idx_lead_emails_org_sent").on(table.orgId, table.sentAt),
  unique("uniq_lead_emails_org_id").on(table.orgId, table.id),
]);

export const leadScoringRules = pgTable("lead_scoring_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  field: text("field").notNull(),
  operator: scoringOperatorEnum("operator").notNull(),
  value: text("value").notNull(),
  points: integer("points").notNull(),
  dimension: text("dimension").notNull().default("fit"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_scoring_rules_org").on(table.orgId),
  unique("uniq_lead_scoring_rules_org_id").on(table.orgId, table.id),
]);

export interface AssignmentConfig {
  weights?: Record<string, number>;
  leastLoadedWindowDays?: number;
  fallbackUserId?: string;
}

export const leadAssignmentRules = pgTable("lead_assignment_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  conditions: jsonb("conditions").$type<{ field: string; operator: string; value: string }[]>().default([]),
  assignmentType: assignmentRuleTypeEnum("assignment_type").notNull(),
  assignToUserId: text("assign_to_user_id").references(() => users.id),
  roundRobinUserIds: jsonb("round_robin_user_ids").$type<string[]>().default([]),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").default(true).notNull(),
  config: jsonb("config").$type<AssignmentConfig>().default({}).notNull(),
  assignmentTypeText: text("assignment_type_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_assignment_rules_org").on(table.orgId),
  unique("uniq_lead_assignment_rules_org_id").on(table.orgId, table.id),
]);

export const assignmentRuleState = pgTable("assignment_rule_state", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").references(() => leadAssignmentRules.id, { onDelete: "cascade" }).notNull().unique(),
  lastAssignedIndex: integer("last_assigned_index").default(0).notNull(),
});


export const leadImportBatches = pgTable("lead_import_batches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  filename: text("filename").notNull(),
  status: text("status").notNull().default("PROCESSING"),
  totalRows: integer("total_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  errorReport: jsonb("error_report").$type<Array<{ row: number; error: string }>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_lead_batches_org").on(table.orgId),
  unique("uniq_lead_import_batches_org_id").on(table.orgId, table.id),
]);

export const webLeadForms = pgTable("web_lead_forms", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  fields: jsonb("fields").$type<Array<{ name: string; label: string; type: string; required: boolean; options?: string[] }>>().notNull().default([]),
  publicToken: text("public_token").notNull().unique(),
  isActive: boolean("is_active").default(true).notNull(),
  submitMessage: text("submit_message").default("Thank you! We'll be in touch soon.").notNull(),
  redirectUrl: text("redirect_url"),
  totalSubmissions: integer("total_submissions").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("web_lead_forms_org_id_idx").on(table.orgId),
  uniqueIndex("web_lead_forms_token_idx").on(table.publicToken),
  unique("uniq_web_lead_forms_org_id").on(table.orgId, table.id),
]);

export const leadActivitiesRelations = relations(leadActivities, ({ one }) => ({
  user: one(users, { fields: [leadActivities.userId], references: [users.id] }),
}));

export const leadNotesRelations = relations(leadNotes, ({ one }) => ({
  author: one(users, { fields: [leadNotes.authorId], references: [users.id] }),
}));

export const leadTasksRelations = relations(leadTasks, ({ one }) => ({
  assignee: one(users, { fields: [leadTasks.assigneeId], references: [users.id] }),
}));

export const leadScoringRulesRelations = relations(leadScoringRules, ({ one }) => ({
  organization: one(organizations, { fields: [leadScoringRules.orgId], references: [organizations.id] }),
}));

export const leadAssignmentRulesRelations = relations(leadAssignmentRules, ({ one }) => ({
  organization: one(organizations, { fields: [leadAssignmentRules.orgId], references: [organizations.id] }),
  assignToUser: one(users, { fields: [leadAssignmentRules.assignToUserId], references: [users.id] }),
}));

export const assignmentRuleStateRelations = relations(assignmentRuleState, ({ one }) => ({
  rule: one(leadAssignmentRules, { fields: [assignmentRuleState.ruleId], references: [leadAssignmentRules.id] }),
}));

export const leadImportBatchesRelations = relations(leadImportBatches, ({ one }) => ({
  organization: one(organizations, { fields: [leadImportBatches.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [leadImportBatches.createdBy], references: [users.id] }),
}));

export const webLeadFormsRelations = relations(webLeadForms, ({ one }) => ({
  organization: one(organizations, { fields: [webLeadForms.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [webLeadForms.createdBy], references: [users.id] }),
}));
