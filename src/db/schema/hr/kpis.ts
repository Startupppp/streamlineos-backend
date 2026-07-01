import { pgTable, text, serial, timestamp, boolean, decimal, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export const kpiDefinitions = pgTable("kpi_definitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  unit: text("unit"),
  target: decimal("target", { precision: 10, scale: 2 }),
  weight: decimal("weight", { precision: 5, scale: 2 }).default("1").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_kpi_definitions_org").on(table.orgId, table.isActive),
]);

export const competencyFrameworks = pgTable("competency_frameworks", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  ratingScale: integer("rating_scale").default(5).notNull(),
  levels: jsonb("levels").$type<{ level: number; label: string; description: string }[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_competency_frameworks_org_name").on(table.orgId, table.name),
]);

export const competencies = pgTable("competencies", {
  id: serial("id").primaryKey(),
  frameworkId: integer("framework_id").references(() => competencyFrameworks.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  weight: decimal("weight", { precision: 5, scale: 2 }).default("1").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_competencies_framework").on(table.frameworkId),
]);

export const competencyFrameworksRelations = relations(competencyFrameworks, ({ many }) => ({
  competencies: many(competencies),
}));

export const competenciesRelations = relations(competencies, ({ one }) => ({
  framework: one(competencyFrameworks, { fields: [competencies.frameworkId], references: [competencyFrameworks.id] }),
}));
