import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  clientAccountStatusEnum, branchStatusEnum, orgSizeEnum, crmHealthEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { leads } from "./leads";

export const branches = pgTable("branches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  city: text("city"),
  state: text("state"),
  country: text("country").default("India").notNull(),
  pincode: text("pincode"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  branchManagerId: text("branch_manager_id").references(() => users.id),
  branchHrId: text("branch_hr_id").references(() => users.id),
  status: branchStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_branches_org").on(table.orgId),
  uniqueIndex("uniq_branch_code_org").on(table.orgId, table.code),
]);

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  designation: text("designation"),
  city: text("city"),
  state: text("state"),
  gstin: text("gstin"),
  isVendor: boolean("is_vendor").default(false).notNull(),
  investmentValue: decimal("investment_value", { precision: 15, scale: 2 }),
  status: text("status").default("active").notNull(),
  accountManagerId: text("account_manager_id").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  healthScore: integer("health_score").default(50).notNull(),
  healthStatus: crmHealthEnum("health_status").default("healthy").notNull(),
  lastHealthCheck: timestamp("last_health_check"),
  churnRiskScore: integer("churn_risk_score"),
  churnRiskReasoning: text("churn_risk_reasoning"),
  convertedAt: timestamp("converted_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_clients_org_status").on(table.orgId, table.status),
  index("idx_clients_account_manager").on(table.accountManagerId),
]);

export const clientAccounts = pgTable("client_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  branchId: integer("branch_id").references(() => branches.id),
  leadId: integer("lead_id").notNull().references(() => leads.id),
  salesRepId: text("sales_rep_id").notNull().references(() => users.id),
  assignedCrmId: text("assigned_crm_id").references(() => users.id),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientPhone: text("client_phone"),
  clientWhatsapp: text("client_whatsapp"),
  status: clientAccountStatusEnum("status").notNull().default("ACCOUNT_OPENING"),
  investmentAmount: decimal("investment_amount", { precision: 15, scale: 2 }),
  planName: text("plan_name"),
  investmentDate: timestamp("investment_date"),
  transactionRef: text("transaction_ref"),
  conversionNotes: text("conversion_notes"),
  estimatedInvestment: decimal("estimated_investment", { precision: 15, scale: 2 }),
  convertedAt: timestamp("converted_at").defaultNow().notNull(),
  investedAt: timestamp("invested_at"),
  renewalStage: text("renewal_stage").default("upcoming").notNull(),
  renewalDate: date("renewal_date"),
  renewalNotes: text("renewal_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_client_accounts_org").on(table.orgId),
  index("idx_client_accounts_sales_rep").on(table.salesRepId),
  index("idx_client_accounts_status").on(table.orgId, table.status),
]);

export const clientAccountActivities = pgTable("client_account_activities", {
  id: serial("id").primaryKey(),
  clientAccountId: integer("client_account_id").notNull().references(() => clientAccounts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  activityType: text("activity_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_client_account_activities_account").on(table.clientAccountId),
  index("idx_client_account_activities_user").on(table.userId),
]);

export const crmOrganizations = pgTable("crm_organizations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  domain: text("domain"),
  industry: text("industry"),
  size: orgSizeEnum("size"),
  website: text("website"),
  linkedinUrl: text("linkedin_url"),
  description: text("description"),
  healthScore: integer("health_score"),
  parentId: integer("parent_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_organizations_org").on(table.orgId),
  index("idx_crm_organizations_parent").on(table.orgId, table.parentId),
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete("set null"),
]);

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  title: text("title"),
  department: text("department"),
  company: text("company"),
  organizationId: integer("organization_id").references(() => crmOrganizations.id, { onDelete: "set null" }),
  linkedinUrl: text("linkedin_url"),
  twitterUrl: text("twitter_url"),
  websiteUrl: text("website_url"),
  avatarUrl: text("avatar_url"),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  dealId: integer("deal_id"),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_contacts_org").on(table.orgId),
  index("idx_contacts_organization").on(table.organizationId),
  index("idx_contacts_name_email").on(table.orgId, table.name, table.email),
]);

export const clientOpportunities = pgTable("client_opportunities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  type: text("type").default("upsell").notNull(),
  stage: text("stage").default("identified").notNull(),
  value: decimal("value", { precision: 15, scale: 2 }),
  notes: text("notes"),
  expectedCloseDate: date("expected_close_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_client_opps_org").on(table.orgId),
  index("idx_client_opps_client").on(table.clientId),
]);

export const clientOnboardingTemplates = pgTable("client_onboarding_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: boolean("is_default").default(false).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_client_onboarding_templates_org").on(table.orgId),
]);

export const clientOnboardingItems = pgTable("client_onboarding_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  templateId: integer("template_id").references(() => clientOnboardingTemplates.id),
  title: text("title").notNull(),
  description: text("description"),
  assignedTo: text("assigned_to").references(() => users.id),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by").references(() => users.id),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_onboarding_items_client").on(table.clientId),
  index("idx_onboarding_items_org").on(table.orgId),
]);

export const csatSurveys = pgTable("csat_surveys", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  question: text("question").notNull().default("How satisfied are you with our service?"),
  scaleMax: integer("scale_max").default(5).notNull(),
  status: text("status").default("draft").notNull(),
  publicToken: text("public_token").notNull(),
  sentAt: timestamp("sent_at"),
  closedAt: timestamp("closed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_csat_surveys_org").on(table.orgId),
  uniqueIndex("idx_csat_surveys_token").on(table.publicToken),
]);

export const csatResponses = pgTable("csat_responses", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").references(() => csatSurveys.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  respondentName: text("respondent_name"),
  respondentEmail: text("respondent_email"),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (table) => [
  index("idx_csat_responses_survey").on(table.surveyId),
]);

export const branchesRelations = relations(branches, ({ one }) => ({
  organization: one(organizations, { fields: [branches.orgId], references: [organizations.id] }),
  branchManager: one(users, { fields: [branches.branchManagerId], references: [users.id], relationName: "branchManager" }),
  branchHr: one(users, { fields: [branches.branchHrId], references: [users.id], relationName: "branchHr" }),
}));

export const clientsRelations = relations(clients, ({ one }) => ({
  lead: one(leads, { fields: [clients.leadId], references: [leads.id] }),
  accountManager: one(users, { fields: [clients.accountManagerId], references: [users.id] }),
}));

export const clientAccountsRelations = relations(clientAccounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [clientAccounts.orgId], references: [organizations.id] }),
  branch: one(branches, { fields: [clientAccounts.branchId], references: [branches.id] }),
  lead: one(leads, { fields: [clientAccounts.leadId], references: [leads.id] }),
  salesRep: one(users, { fields: [clientAccounts.salesRepId], references: [users.id], relationName: "clientAccountSalesRep" }),
  assignedCrm: one(users, { fields: [clientAccounts.assignedCrmId], references: [users.id], relationName: "clientAccountCrm" }),
  activities: many(clientAccountActivities),
}));

export const clientAccountActivitiesRelations = relations(clientAccountActivities, ({ one }) => ({
  clientAccount: one(clientAccounts, { fields: [clientAccountActivities.clientAccountId], references: [clientAccounts.id] }),
  user: one(users, { fields: [clientAccountActivities.userId], references: [users.id] }),
}));

export const crmOrganizationsRelations = relations(crmOrganizations, ({ one, many }) => ({
  org: one(organizations, { fields: [crmOrganizations.orgId], references: [organizations.id] }),
  contacts: many(contacts),
  parent: one(crmOrganizations, { fields: [crmOrganizations.parentId], references: [crmOrganizations.id], relationName: "orgParent" }),
  children: many(crmOrganizations, { relationName: "orgParent" }),
}));


export const clientOpportunitiesRelations = relations(clientOpportunities, ({ one }) => ({
  client: one(clients, { fields: [clientOpportunities.clientId], references: [clients.id] }),
  creator: one(users, { fields: [clientOpportunities.createdBy], references: [users.id] }),
}));

export const clientOnboardingTemplatesRelations = relations(clientOnboardingTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [clientOnboardingTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [clientOnboardingTemplates.createdBy], references: [users.id] }),
  items: many(clientOnboardingItems),
}));

export const clientOnboardingItemsRelations = relations(clientOnboardingItems, ({ one }) => ({
  client: one(clients, { fields: [clientOnboardingItems.clientId], references: [clients.id] }),
  template: one(clientOnboardingTemplates, { fields: [clientOnboardingItems.templateId], references: [clientOnboardingTemplates.id] }),
  assignee: one(users, { fields: [clientOnboardingItems.assignedTo], references: [users.id] }),
  completedByUser: one(users, { fields: [clientOnboardingItems.completedBy], references: [users.id] }),
}));

export const csatSurveysRelations = relations(csatSurveys, ({ one, many }) => ({
  organization: one(organizations, { fields: [csatSurveys.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [csatSurveys.clientId], references: [clients.id] }),
  creator: one(users, { fields: [csatSurveys.createdBy], references: [users.id] }),
  responses: many(csatResponses),
}));

export const csatResponsesRelations = relations(csatResponses, ({ one }) => ({
  survey: one(csatSurveys, { fields: [csatResponses.surveyId], references: [csatSurveys.id] }),
}));
