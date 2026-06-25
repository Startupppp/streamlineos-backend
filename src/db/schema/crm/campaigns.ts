import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { crmCampaignStatusEnum, crmLeadStatusEnum, crmEventStatusEnum } from "../enums";
import { organizations, users } from "../auth";

export const crmCampaigns = pgTable("crm_campaigns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  status: crmCampaignStatusEnum("status").default("active").notNull(),
  channel: text("channel"),
  description: text("description"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  targetAudience: text("target_audience"),
  leads: integer("leads").default(0).notNull(),
  spend: decimal("spend", { precision: 15, scale: 2 }).default("0").notNull(),
  roi: decimal("roi", { precision: 8, scale: 4 }).default("0").notNull(),
  budgetAllocated: decimal("budget_allocated", { precision: 15, scale: 2 }),
  budgetSpent: decimal("budget_spent", { precision: 15, scale: 2 }),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const crmLeads = pgTable("crm_leads", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  campaignId: integer("campaign_id").references(() => crmCampaigns.id),
  email: text("email"),
  name: text("name"),
  status: crmLeadStatusEnum("status").default("lead").notNull(),
  channel: text("channel"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmContent = pgTable("crm_content", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  views: integer("views").default(0).notNull(),
  leads: integer("leads").default(0).notNull(),
  convRate: decimal("conv_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const crmEvents = pgTable("crm_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  status: crmEventStatusEnum("status").default("planning").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const emailCampaigns = pgTable("email_campaigns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  templateId: integer("template_id"),
  status: text("status").default("draft").notNull(),
  recipientFilter: jsonb("recipient_filter"),
  recipientCount: integer("recipient_count").default(0).notNull(),
  sentCount: integer("sent_count").default(0).notNull(),
  failedCount: integer("failed_count").default(0).notNull(),
  openCount: integer("open_count").default(0).notNull(),
  clickCount: integer("click_count").default(0).notNull(),
  scheduledAt: timestamp("scheduled_at"),
  sentAt: timestamp("sent_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_email_campaigns_org").on(table.orgId, table.status),
]);

export const crmCampaignsRelations = relations(crmCampaigns, ({ one, many }) => ({
  organization: one(organizations, { fields: [crmCampaigns.orgId], references: [organizations.id] }),
  leads: many(crmLeads),
}));

export const crmLeadsRelations = relations(crmLeads, ({ one }) => ({
  organization: one(organizations, { fields: [crmLeads.orgId], references: [organizations.id] }),
  campaign: one(crmCampaigns, { fields: [crmLeads.campaignId], references: [crmCampaigns.id] }),
}));
