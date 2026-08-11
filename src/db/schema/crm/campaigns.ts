import { pgTable, text, serial, timestamp, decimal, date, integer, unique, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { crmCampaignStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

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
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  unique("uniq_crm_campaigns_org_id").on(t.orgId, t.id),
  index("idx_crm_campaigns_org_live").on(t.orgId).where(sql`${t.deletedAt} IS NULL`),
]);

export const crmCampaignsRelations = relations(crmCampaigns, ({ one }) => ({
  organization: one(organizations, { fields: [crmCampaigns.orgId], references: [organizations.id] }),
}));

