import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { jobPostingStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";

export const hiringFlows = pgTable("hiring_flows", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hiring_flows_org_id").on(table.orgId, table.id),
  index("idx_hiring_flows_org").on(table.orgId),
]);

export const scorecardTemplates = pgTable("scorecard_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  criteria: jsonb("criteria").$type<Array<{ name: string; weight: number }>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_scorecard_templates_org_id").on(table.orgId, table.id),
  index("idx_scorecard_templates_org").on(table.orgId),
]);

export const hiringFlowRounds = pgTable("hiring_flow_rounds", {
  id: serial("id").primaryKey(),
  flowId: integer("flow_id").references(() => hiringFlows.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  roundType: text("round_type").$type<"HR_SCREENING" | "TECHNICAL" | "MANAGER" | "CULTURAL_FIT" | "FINAL" | "CUSTOM">().notNull().default("CUSTOM"),
  mode: text("mode").$type<"VIDEO" | "PHONE" | "ONSITE">().notNull().default("VIDEO"),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  slaDays: integer("sla_days"),
  questionBankTag: text("question_bank_tag"),
  scorecardTemplateId: integer("scorecard_template_id").references(() => scorecardTemplates.id),
  interviewerRoleRestriction: text("interviewer_role_restriction"),
  autoAdvanceThreshold: integer("auto_advance_threshold"),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hiring_flow_rounds_org_id").on(table.orgId, table.id),
  index("idx_hiring_flow_rounds_flow").on(table.flowId),
]);

export interface ScreeningQuestion {
  id: string;
  question: string;
  type: "TEXT" | "YES_NO" | "SINGLE_SELECT" | "NUMBER";
  required: boolean;
  knockout: boolean;
  knockoutAnswer?: string;
  options?: string[];
}

export const jobPostings = pgTable("job_postings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  orgDepartmentId: text("org_department_id").references(() => orgUnits.id, { onDelete: "set null" }),
  hiringFlowId: integer("hiring_flow_id").references(() => hiringFlows.id),
  location: text("location"),
  type: text("type").default("FULL_TIME").notNull(),
  experience: text("experience"),
  salaryMin: decimal("salary_min", { precision: 15, scale: 2 }),
  salaryMax: decimal("salary_max", { precision: 15, scale: 2 }),
  description: text("description"),
  requirements: text("requirements"),
  benefits: text("benefits"),
  status: jobPostingStatusEnum("status").default("DRAFT").notNull(),
  openings: integer("openings").default(1).notNull(),
  applicationDeadline: date("application_deadline"),
  closingDate: timestamp("closing_date"),
  postedBy: text("posted_by").references(() => users.id),
  externalPostingIds: jsonb("external_posting_ids").$type<Record<string, string>>(),
  isInternal: boolean("is_internal").notNull().default(false),
  screeningQuestions: jsonb("screening_questions").$type<ScreeningQuestion[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_job_postings_org_id").on(table.orgId, table.id),
  index("idx_job_postings_org").on(table.orgId),
  index("idx_job_postings_status").on(table.status),
  index("idx_job_postings_org_status").on(table.orgId, table.status),
]);

export const candidateSources = pgTable("candidate_sources", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  oauthToken: text("oauth_token"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  lastSyncedAt: timestamp("last_synced_at"),
  lastSyncCount: integer("last_sync_count").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_candidate_sources_org_id").on(table.orgId, table.id),
  index("idx_candidate_sources_org").on(table.orgId),
  uniqueIndex("uq_candidate_sources_org_platform").on(table.orgId, table.platform),
]);

export const hiringFlowsRelations = relations(hiringFlows, ({ one, many }) => ({
  organization: one(organizations, { fields: [hiringFlows.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [hiringFlows.createdBy], references: [users.id] }),
  rounds: many(hiringFlowRounds),
  jobPostings: many(jobPostings),
}));

export const hiringFlowRoundsRelations = relations(hiringFlowRounds, ({ one }) => ({
  flow: one(hiringFlows, { fields: [hiringFlowRounds.flowId], references: [hiringFlows.id] }),
  scorecardTemplate: one(scorecardTemplates, { fields: [hiringFlowRounds.scorecardTemplateId], references: [scorecardTemplates.id] }),
}));

export const scorecardTemplatesRelations = relations(scorecardTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [scorecardTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [scorecardTemplates.createdBy], references: [users.id] }),
}));

export const jobPostingsRelations = relations(jobPostings, ({ one, many }) => ({
  organization: one(organizations, { fields: [jobPostings.orgId], references: [organizations.id] }),
  orgDepartment: one(orgUnits, { fields: [jobPostings.orgDepartmentId], references: [orgUnits.id] }),
  hiringFlow: one(hiringFlows, { fields: [jobPostings.hiringFlowId], references: [hiringFlows.id] }),
  postedByUser: one(users, { fields: [jobPostings.postedBy], references: [users.id] }),
}));

export const candidateSourcesRelations = relations(candidateSources, ({ one }) => ({
  organization: one(organizations, { fields: [candidateSources.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [candidateSources.createdBy], references: [users.id] }),
}));
