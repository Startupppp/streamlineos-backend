import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  crmPersonRoleEnum, crmHealthEnum, crmDealStageEnum,
  crmSupportTicketStatusEnum, crmSupportTicketPriorityEnum, crmActivityTypeEnum,
  slaAppliesToEnum, slaPriorityEnum,
} from "../enums";
import { organizations, users } from "../auth";

export const crmPeople = pgTable("crm_people", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  role: crmPersonRoleEnum("role").notNull(),
  title: text("title").notNull(),
  department: text("department").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  location: text("location"),
  joinDate: text("join_date"),
  bio: text("bio"),
  skills: text("skills").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmCompanies = pgTable("crm_companies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  health: crmHealthEnum("health").default("healthy").notNull(),
  revenue: decimal("revenue", { precision: 15, scale: 2 }).default("0").notNull(),
  renewalDate: date("renewal_date"),
  renewalValue: decimal("renewal_value", { precision: 15, scale: 2 }).default("0").notNull(),
  customerSince: text("customer_since"),
  csmId: integer("csm_id").references(() => crmPeople.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmDeals = pgTable("crm_deals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  companyName: text("company_name").notNull(),
  value: decimal("value", { precision: 15, scale: 2 }).notNull(),
  stage: crmDealStageEnum("stage").notNull(),
  probability: integer("probability").default(0).notNull(),
  closeDate: date("close_date"),
  salesRepId: integer("sales_rep_id").references(() => crmPeople.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const crmActivities = pgTable("crm_activities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  type: crmActivityTypeEnum("type").notNull(),
  message: text("message").notNull(),
  time: text("time").notNull(),
  person: text("person"),
  personId: integer("person_id").references(() => crmPeople.id),
  category: text("category").notNull().default("sales"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmSupportTickets = pgTable("crm_support_tickets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title"),
  priority: crmSupportTicketPriorityEnum("priority").default("medium").notNull(),
  status: crmSupportTicketStatusEnum("status").default("new").notNull(),
  assigneeId: integer("assignee_id").references(() => crmPeople.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});

export const crmMonthlyMetrics = pgTable("crm_monthly_metrics", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  revenue: decimal("revenue", { precision: 15, scale: 2 }).default("0").notNull(),
  mqls: integer("mqls").default(0).notNull(),
  retention: decimal("retention", { precision: 5, scale: 2 }).default("0").notNull(),
  csat: decimal("csat", { precision: 4, scale: 2 }).default("0").notNull(),
  ticketVolume: integer("ticket_volume").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmTeamPerformance = pgTable("crm_team_performance", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  personId: integer("person_id").references(() => crmPeople.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  value: decimal("value", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmSupportTeamMembers = pgTable("crm_support_team_members", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  access: text("access").notNull(),
  avatar: text("avatar").notNull(),
  status: text("status").default("online").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmEmailTemplates = pgTable("crm_email_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_email_templates_org").on(table.orgId),
]);

export const crmSla = pgTable("crm_sla_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  appliesTo: slaAppliesToEnum("applies_to").notNull(),
  priority: slaPriorityEnum("priority").notNull(),
  firstResponseHours: integer("first_response_hours").notNull(),
  resolutionHours: integer("resolution_hours").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_crm_sla_org").on(table.orgId),
]);

export const crmViews = pgTable("crm_views", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}),
  sortBy: text("sort_by"),
  sortDir: text("sort_dir").default("asc").notNull(),
  isPublic: boolean("is_public").default(false).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_crm_views_org").on(table.orgId),
]);

export const emailCampaignRecipients = pgTable("email_campaign_recipients", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  leadId: integer("lead_id"),
  email: text("email").notNull(),
  name: text("name"),
  status: text("status").default("pending").notNull(),
  sentAt: timestamp("sent_at"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  errorMessage: text("error_message"),
}, (table) => [
  index("idx_ecr_campaign").on(table.campaignId, table.status),
  index("idx_ecr_lead").on(table.leadId),
]);

export const crmPeopleRelations = relations(crmPeople, ({ one, many }) => ({
  organization: one(organizations, { fields: [crmPeople.orgId], references: [organizations.id] }),
  deals: many(crmDeals),
  managedCompanies: many(crmCompanies),
  activities: many(crmActivities),
  performance: many(crmTeamPerformance),
}));

export const crmCompaniesRelations = relations(crmCompanies, ({ one }) => ({
  organization: one(organizations, { fields: [crmCompanies.orgId], references: [organizations.id] }),
  csm: one(crmPeople, { fields: [crmCompanies.csmId], references: [crmPeople.id] }),
}));

export const crmDealsRelations = relations(crmDeals, ({ one }) => ({
  organization: one(organizations, { fields: [crmDeals.orgId], references: [organizations.id] }),
  salesRep: one(crmPeople, { fields: [crmDeals.salesRepId], references: [crmPeople.id] }),
}));

export const crmActivitiesRelations = relations(crmActivities, ({ one }) => ({
  organization: one(organizations, { fields: [crmActivities.orgId], references: [organizations.id] }),
  crmPerson: one(crmPeople, { fields: [crmActivities.personId], references: [crmPeople.id] }),
}));

export const crmSupportTicketsRelations = relations(crmSupportTickets, ({ one }) => ({
  organization: one(organizations, { fields: [crmSupportTickets.orgId], references: [organizations.id] }),
  assignee: one(crmPeople, { fields: [crmSupportTickets.assigneeId], references: [crmPeople.id] }),
}));

export const crmTeamPerformanceRelations = relations(crmTeamPerformance, ({ one }) => ({
  organization: one(organizations, { fields: [crmTeamPerformance.orgId], references: [organizations.id] }),
  person: one(crmPeople, { fields: [crmTeamPerformance.personId], references: [crmPeople.id] }),
}));

export const crmEmailTemplatesRelations = relations(crmEmailTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [crmEmailTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [crmEmailTemplates.createdBy], references: [users.id] }),
}));

export const crmSlaRelations = relations(crmSla, ({ one }) => ({
  organization: one(organizations, { fields: [crmSla.orgId], references: [organizations.id] }),
}));

export const crmViewsRelations = relations(crmViews, ({ one }) => ({
  organization: one(organizations, { fields: [crmViews.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [crmViews.createdBy], references: [users.id] }),
}));
