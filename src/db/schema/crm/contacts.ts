import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { clientAccountStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";

export const clientAccounts = pgTable("client_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  branchId: text("branch_id").references(() => orgUnits.id, { onDelete: "set null" }),
  leadId: integer("lead_id").notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  salesRepId: text("sales_rep_id").notNull().references(() => users.id),
  salesRepMembershipId: integer("sales_rep_membership_id"),
  assignedCrmId: text("assigned_crm_id").references(() => users.id),
  assignedCrmMembershipId: integer("assigned_crm_membership_id"),
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
  unique("uniq_client_accounts_org_id").on(table.orgId, table.id),
]);

export const clientAccountActivities = pgTable("client_account_activities", {
  id: serial("id").primaryKey(),
  clientAccountId: integer("client_account_id").notNull().references(() => clientAccounts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  userMembershipId: integer("user_membership_id"),
  activityType: text("activity_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_client_account_activities_account").on(table.clientAccountId),
  index("idx_client_account_activities_user").on(table.userId),
]);

export const clientOpportunities = pgTable("client_opportunities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").notNull(),
  /**
   * The party this row's client is. Ticket 08's expand.
   *
   * Beside `client_id` rather than replacing it: every existing reader keeps
   * working while readers move over one at a time, and the old column goes in
   * the contract migration once none is left.
   */
  clientPartyId: text("client_party_id"),
  title: text("title").notNull(),
  type: text("type").default("upsell").notNull(),
  stage: text("stage").default("identified").notNull(),
  value: decimal("value", { precision: 15, scale: 2 }),
  notes: text("notes"),
  expectedCloseDate: date("expected_close_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_client_opps_org").on(table.orgId),
  index("idx_client_opps_client").on(table.clientId),
  unique("uniq_client_opportunities_org_id").on(table.orgId, table.id),
]);

export const clientOnboardingTemplates = pgTable("client_onboarding_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: boolean("is_default").default(false).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_client_onboarding_templates_org").on(table.orgId),
  unique("uniq_client_onboarding_tmpls_org_id").on(table.orgId, table.id),
]);

export const clientOnboardingItems = pgTable("client_onboarding_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").notNull(),
  /**
   * The party this row's client is. Ticket 08's expand.
   *
   * Beside `client_id` rather than replacing it: every existing reader keeps
   * working while readers move over one at a time, and the old column goes in
   * the contract migration once none is left.
   */
  clientPartyId: text("client_party_id"),
  templateId: integer("template_id").references(() => clientOnboardingTemplates.id),
  title: text("title").notNull(),
  description: text("description"),
  assignedTo: text("assigned_to").references(() => users.id),
  assignedToMembershipId: integer("assigned_to_membership_id"),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by").references(() => users.id),
  completedByMembershipId: integer("completed_by_membership_id"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_onboarding_items_client").on(table.clientId),
  index("idx_onboarding_items_org").on(table.orgId),
  unique("uniq_client_onboarding_items_org_id").on(table.orgId, table.id),
]);

export const csatSurveys = pgTable("csat_surveys", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id"),
  /**
  * The party this row belongs to. Ticket 08's expand.
  *
  * Beside `client_id` rather than replacing it: every existing reader keeps
  * working while readers move over one at a time, and the old column goes in
  * the contract migration once none is left. Nullable until then -- a null
  * means "not yet backfilled", which is a state worth being able to see.
  */
  clientPartyId: text("client_party_id"),
  title: text("title").notNull(),
  question: text("question").notNull().default("How satisfied are you with our service?"),
  scaleMax: integer("scale_max").default(5).notNull(),
  status: text("status").default("draft").notNull(),
  publicToken: text("public_token").notNull(),
  sentAt: timestamp("sent_at"),
  closedAt: timestamp("closed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_csat_surveys_org").on(table.orgId),
  uniqueIndex("idx_csat_surveys_token").on(table.publicToken),
  unique("uniq_csat_surveys_org_id").on(table.orgId, table.id),
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
  unique("uniq_csat_responses_org_id").on(table.orgId, table.id),
]);

export const clientAccountsRelations = relations(clientAccounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [clientAccounts.orgId], references: [organizations.id] }),
  branch: one(orgUnits, { fields: [clientAccounts.branchId], references: [orgUnits.id] }),
  salesRep: one(users, { fields: [clientAccounts.salesRepId], references: [users.id], relationName: "clientAccountSalesRep" }),
  assignedCrm: one(users, { fields: [clientAccounts.assignedCrmId], references: [users.id], relationName: "clientAccountCrm" }),
  activities: many(clientAccountActivities),
}));

export const clientAccountActivitiesRelations = relations(clientAccountActivities, ({ one }) => ({
  clientAccount: one(clientAccounts, { fields: [clientAccountActivities.clientAccountId], references: [clientAccounts.id] }),
  user: one(users, { fields: [clientAccountActivities.userId], references: [users.id] }),
}));

export const clientOpportunitiesRelations = relations(clientOpportunities, ({ one }) => ({
  creator: one(users, { fields: [clientOpportunities.createdBy], references: [users.id] }),
}));

export const clientOnboardingTemplatesRelations = relations(clientOnboardingTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [clientOnboardingTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [clientOnboardingTemplates.createdBy], references: [users.id] }),
  items: many(clientOnboardingItems),
}));

export const clientOnboardingItemsRelations = relations(clientOnboardingItems, ({ one }) => ({
  template: one(clientOnboardingTemplates, { fields: [clientOnboardingItems.templateId], references: [clientOnboardingTemplates.id] }),
  assignee: one(users, { fields: [clientOnboardingItems.assignedTo], references: [users.id] }),
  completedByUser: one(users, { fields: [clientOnboardingItems.completedBy], references: [users.id] }),
}));

export const csatSurveysRelations = relations(csatSurveys, ({ one, many }) => ({
  organization: one(organizations, { fields: [csatSurveys.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [csatSurveys.createdBy], references: [users.id] }),
  responses: many(csatResponses),
}));

export const csatResponsesRelations = relations(csatResponses, ({ one }) => ({
  survey: one(csatSurveys, { fields: [csatResponses.surveyId], references: [csatSurveys.id] }),
}));
