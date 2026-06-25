import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export interface RoutingRuleCondition {
  field: string;
  op: "eq" | "neq" | "contains";
  value: string;
}

export const supportMacros = pgTable(
  "support_macros",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_support_macros_org").on(table.orgId),
  ],
);

export const supportRoutingRules = pgTable(
  "support_routing_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    conditions: jsonb("conditions").$type<RoutingRuleCondition[]>().default([]).notNull(),
    assigneeId: text("assignee_id"),
    setPriority: text("set_priority"),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_support_routing_rules_org_enabled").on(table.orgId, table.isEnabled),
  ],
);

export const supportMacrosRelations = relations(supportMacros, ({ one }) => ({
  organization: one(organizations, { fields: [supportMacros.orgId], references: [organizations.id] }),
}));

export const supportRoutingRulesRelations = relations(supportRoutingRules, ({ one }) => ({
  organization: one(organizations, { fields: [supportRoutingRules.orgId], references: [organizations.id] }),
}));
