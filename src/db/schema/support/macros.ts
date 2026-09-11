import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";

export interface RoutingRuleCondition {
  field: string;
  op: "eq" | "neq" | "contains";
  value: string;
}

export interface MacroActions {
  setStatus?: string;
  setPriority?: string;
  addTagId?: number;
  isInternal?: boolean;
}

export const supportMacros = pgTable(
  "support_macros",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category"),
    visibility: text("visibility").default("org").notNull(),
    actions: jsonb("actions").$type<MacroActions>().default({}).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_support_macros_org_id").on(table.orgId, table.id),
    index("idx_support_macros_org_created_actor").on(table.orgId, table.createdByMembershipId),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_macros_created_actor",
    }).onDelete("set null"),
  ],
);

export const supportRoutingRules = pgTable(
  "support_routing_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    conditions: jsonb("conditions").$type<RoutingRuleCondition[]>().default([]).notNull(),
    assigneeMembershipId: integer("assignee_membership_id"),
    setPriority: text("set_priority"),
    assignmentMode: text("assignment_mode").default("static").notNull(),
    candidateAgentIds: jsonb("candidate_agent_ids").$type<string[]>().default([]).notNull(),
    requiredSkills: jsonb("required_skills").$type<string[]>().default([]).notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_support_routing_rules_org_enabled").on(table.orgId, table.isEnabled),
    unique("uniq_support_routing_rules_org_id").on(table.orgId, table.id),
    index("idx_support_routing_rules_org_assignee_actor").on(table.orgId, table.assigneeMembershipId),
    foreignKey({
      columns: [table.orgId, table.assigneeMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_routing_rules_assignee_actor",
    }).onDelete("set null"),
  ],
);

export const supportMacrosRelations = relations(supportMacros, ({ one }) => ({
  organization: one(organizations, { fields: [supportMacros.orgId], references: [organizations.id] }),
}));

export const supportRoutingRulesRelations = relations(supportRoutingRules, ({ one }) => ({
  organization: one(organizations, { fields: [supportRoutingRules.orgId], references: [organizations.id] }),
}));
