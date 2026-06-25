import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, foreignKey, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  leadPipelineStatusEnum, leadActivityTypeEnum, leadSourceEnum, leadPriorityEnum,
  leadEmailDirectionEnum, leadTaskStatusEnum, scoringOperatorEnum,
  assignmentRuleTypeEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { crmCampaigns } from "./campaigns";

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  whatsappNumber: text("whatsapp_number"),
  source: leadSourceEnum("source").default("other").notNull(),
  campaignId: integer("campaign_id").references(() => crmCampaigns.id, { onDelete: "set null" }),
  status: leadPipelineStatusEnum("status").default("NEW").notNull(),
  priority: leadPriorityEnum("priority").default("WARM").notNull(),
  investmentInterest: decimal("investment_interest", { precision: 15, scale: 2 }),
  potentialValue: decimal("potential_value", { precision: 15, scale: 2 }),
  notes: text("notes"),
  assignedToId: text("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
  assignedById: text("assigned_by_id").references(() => users.id, { onDelete: "set null" }),
  verifiedById: text("verified_by_id").references(() => users.id, { onDelete: "set null" }),
  assignedAt: timestamp("assigned_at"),
  convertedAt: timestamp("converted_at"),
  lostReason: text("lost_reason"),
  company: text("company"),
  designation: text("designation"),
  city: text("city"),
  referredBy: text("referred_by"),
  tags: text("tags").array(),
  score: integer("score").default(0).notNull(),
  slaDeadline: timestamp("sla_deadline"),
  website: text("website"),
  subSource: text("sub_source"),
  dmLeadId: integer("dm_lead_id"),
  followUpDate: timestamp("follow_up_date"),
  followUpNotes: text("follow_up_notes"),
  customData: jsonb("custom_data").$type<Record<string, unknown>>(),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  ipAddress: text("ip_address"),
  referrerUrl: text("referrer_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
  mergedIntoId: integer("merged_into_id"),
}, (table) => [
  foreignKey({ columns: [table.mergedIntoId], foreignColumns: [table.id] }).onDelete("set null"),
  index("idx_leads_org_status_created").on(table.orgId, table.status, table.createdAt),
  index("idx_leads_assigned_to").on(table.assignedToId),
  index("idx_leads_source").on(table.source),
  index("idx_leads_score").on(table.score),
  index("idx_leads_deleted").on(table.deletedAt),
]);

export const leadActivities = pgTable("lead_activities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
  type: leadActivityTypeEnum("type").notNull(),
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
]);

export const leadNotes = pgTable("lead_notes", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  authorId: text("author_id").references(() => users.id).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_notes_lead").on(table.leadId),
  index("idx_lead_notes_org_created").on(table.orgId, table.createdAt),
]);

export const leadTasks = pgTable("lead_tasks", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  dueDate: date("due_date"),
  assigneeId: text("assignee_id").references(() => users.id),
  status: leadTaskStatusEnum("status").default("open").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_tasks_lead").on(table.leadId),
  index("idx_lead_tasks_org_status").on(table.orgId, table.status),
]);

export const leadEmails = pgTable("lead_emails", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
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
]);

export const leadScoringRules = pgTable("lead_scoring_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  field: text("field").notNull(),
  operator: scoringOperatorEnum("operator").notNull(),
  value: text("value").notNull(),
  points: integer("points").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_scoring_rules_org").on(table.orgId),
]);

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_lead_assignment_rules_org").on(table.orgId),
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
]);

export const leadsRelations = relations(leads, ({ one, many }) => ({
  organization: one(organizations, { fields: [leads.orgId], references: [organizations.id] }),
  assignedTo: one(users, { fields: [leads.assignedToId], references: [users.id], relationName: "leadAssignee" }),
  assignedBy: one(users, { fields: [leads.assignedById], references: [users.id], relationName: "leadAssigner" }),
  campaign: one(crmCampaigns, { fields: [leads.campaignId], references: [crmCampaigns.id] }),
  activities: many(leadActivities),
}));

export const leadActivitiesRelations = relations(leadActivities, ({ one }) => ({
  lead: one(leads, { fields: [leadActivities.leadId], references: [leads.id] }),
  user: one(users, { fields: [leadActivities.userId], references: [users.id] }),
}));

export const leadNotesRelations = relations(leadNotes, ({ one }) => ({
  lead: one(leads, { fields: [leadNotes.leadId], references: [leads.id] }),
  author: one(users, { fields: [leadNotes.authorId], references: [users.id] }),
}));

export const leadTasksRelations = relations(leadTasks, ({ one }) => ({
  lead: one(leads, { fields: [leadTasks.leadId], references: [leads.id] }),
  assignee: one(users, { fields: [leadTasks.assigneeId], references: [users.id] }),
}));

export const leadEmailsRelations = relations(leadEmails, ({ one }) => ({
  lead: one(leads, { fields: [leadEmails.leadId], references: [leads.id] }),
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
