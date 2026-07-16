import { pgTable, text, serial, timestamp, decimal, date, integer } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { crmCampaignStatusEnum, crmLeadStatusEnum } from "../enums";
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
  utmCampaignKey: text("utm_campaign_key"),
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

export const crmCampaignsRelations = relations(crmCampaigns, ({ one, many }) => ({
  organization: one(organizations, { fields: [crmCampaigns.orgId], references: [organizations.id] }),
  leads: many(crmLeads),
}));

export const crmLeadsRelations = relations(crmLeads, ({ one }) => ({
  organization: one(organizations, { fields: [crmLeads.orgId], references: [organizations.id] }),
  campaign: one(crmCampaigns, { fields: [crmLeads.campaignId], references: [crmCampaigns.id] }),
}));
