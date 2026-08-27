import { pgTable, text, integer, jsonb, timestamp, index, uuid, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { leads } from "./leads";
import { crmCampaigns } from "./campaigns";

export const crmLeadTouchpoints = pgTable("crm_lead_touchpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
  /**
  * The party behind this row's legacy id. Ticket 08's expand.
  *
  * Beside the old column, not replacing it -- the contract migration removes
  * the old one once nothing reads it. Kept in step by a trigger, so no writer
  * has to remember.
  */
  leadPartyId: text("lead_party_id"),
  campaignId: integer("campaign_id").references(() => crmCampaigns.id, { onDelete: "set null" }),
  sourceKey: text("source_key").notNull(),
  medium: text("medium"),
  utmData: jsonb("utm_data").$type<Record<string, string>>(),
  touchType: text("touch_type").notNull(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_crm_lead_touchpoints_org_lead_occurred").on(table.orgId, table.leadId, table.occurredAt),
  index("idx_crm_lead_touchpoints_org_occurred").on(table.orgId, table.occurredAt),
  unique("uniq_crm_lead_touchpoints_org_id").on(table.orgId, table.id),
]);

export const crmLeadTouchpointsRelations = relations(crmLeadTouchpoints, ({ one }) => ({
  lead: one(leads, { fields: [crmLeadTouchpoints.leadId], references: [leads.id] }),
  campaign: one(crmCampaigns, { fields: [crmLeadTouchpoints.campaignId], references: [crmCampaigns.id] }),
}));
