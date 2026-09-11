import { pgTable, text, serial, timestamp, boolean, integer, jsonb, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { slaAppliesToEnum, slaPriorityEnum } from "../common/enums";
import { organizations } from "../common/auth";

/**
 * Lives here rather than in `analytics.ts`: `crm_sla_policies` is operational
 * configuration read on every SLA evaluation, not a reporting rollup, and
 * `deals.ts` holds an FK to it. Keeping it beside the analytics snapshot tables
 * made the analytics module look like a dependency of the deal graph.
 */
export interface SlaConditions {
  sourceKeys?: string[];
  priorityKeys?: string[];
  scoreMin?: number;
  scoreMax?: number;
  territoryIds?: number[];
  segment?: string;
  appliesToText?: string;
}

export const crmSla = pgTable("crm_sla_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  appliesTo: slaAppliesToEnum("applies_to").notNull(),
  priority: slaPriorityEnum("priority").notNull(),
  firstResponseHours: integer("first_response_hours").notNull(),
  resolutionHours: integer("resolution_hours").notNull(),
  conditions: jsonb("conditions").$type<SlaConditions>().default({}).notNull(),
  targetMinutes: integer("target_minutes"),
  businessHours: boolean("business_hours").default(false).notNull(),
  appliesToText: text("applies_to_text"),
  priorityText: text("priority_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_crm_sla_policies_org_id").on(table.orgId, table.id),
]);

export const crmSlaRelations = relations(crmSla, ({ one }) => ({
  organization: one(organizations, { fields: [crmSla.orgId], references: [organizations.id] }),
}));
