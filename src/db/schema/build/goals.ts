import {
  pgEnum,
  text,
  timestamp,
  numeric,
  date,
  integer,
  foreignKey,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const goalLevelEnum = pgEnum("okr_goal_level", ["company", "team", "individual"]);
export const goalStatusEnum = pgEnum("okr_goal_status", ["not_started", "on_track", "at_risk", "off_track", "completed"]);
export const keyResultMetricEnum = pgEnum("okr_kr_metric", ["number", "percentage", "currency", "boolean"]);

export const okrGoals = build.table("okr_goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  ownerMembershipId: integer("owner_membership_id"),
  level: goalLevelEnum("level").default("company").notNull(),
  status: goalStatusEnum("status").default("not_started").notNull(),
  progress: integer("progress").default(0).notNull(),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  parentGoalId: integer("parent_goal_id"),
  projectId: integer("project_id"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_okr_goals_org_project" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.parentGoalId], foreignColumns: [table.orgId, table.id], name: "fk_okr_goals_org_parent" }),
  index("idx_okr_goals_org").on(table.orgId).where(sql`deleted_at IS NULL`),
  index("idx_okr_goals_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
  index("idx_okr_goals_parent").on(table.parentGoalId),
  index("idx_okr_goals_org_owner_membership").on(table.orgId, table.ownerMembershipId),
  unique("uniq_okr_goals_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_okr_goals_owner_actor",
    columns: [table.orgId, table.ownerMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
  foreignKey({
    name: "fk_okr_goals_created_by_actor",
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);

export const okrKeyResults = build.table("okr_key_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").notNull(),
  title: text("title").notNull(),
  metricType: keyResultMetricEnum("metric_type").default("number").notNull(),
  startValue: numeric("start_value", { precision: 18, scale: 2 }).default("0").notNull(),
  targetValue: numeric("target_value", { precision: 18, scale: 2 }).notNull(),
  currentValue: numeric("current_value", { precision: 18, scale: 2 }).default("0").notNull(),
  unit: text("unit"),
  status: goalStatusEnum("status").default("not_started").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.goalId], foreignColumns: [okrGoals.orgId, okrGoals.id], name: "fk_okr_key_results_org_goal" }).onDelete("cascade"),
  index("idx_okr_key_results_goal").on(table.goalId),
  unique("uniq_okr_key_results_org_id").on(table.orgId, table.id),
]);

export const okrUpdates = build.table("okr_updates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").notNull(),
  keyResultId: integer("key_result_id"),
  note: text("note"),
  previousValue: numeric("previous_value", { precision: 18, scale: 2 }),
  newValue: numeric("new_value", { precision: 18, scale: 2 }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.goalId], foreignColumns: [okrGoals.orgId, okrGoals.id], name: "fk_okr_updates_org_goal" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.keyResultId], foreignColumns: [okrKeyResults.orgId, okrKeyResults.id], name: "fk_okr_updates_org_kr" }).onDelete("set null"),
  index("idx_okr_updates_goal").on(table.goalId),
  unique("uniq_okr_updates_org_id").on(table.orgId, table.id),
]);

export const okrLinks = build.table("okr_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").notNull(),
  ticketId: integer("ticket_id"),
  projectId: integer("project_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.goalId], foreignColumns: [okrGoals.orgId, okrGoals.id], name: "fk_okr_links_org_goal" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_okr_links_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_okr_links_org_ticket" }).onDelete("cascade"),
  uniqueIndex("uniq_okr_links_goal_ticket").on(table.goalId, table.ticketId),
  uniqueIndex("uniq_okr_links_goal_project").on(table.goalId, table.projectId).where(sql`project_id IS NOT NULL`),
  unique("uniq_okr_links_org_id").on(table.orgId, table.id),
]);

export const okrGoalsRelations = relations(okrGoals, ({ one, many }) => ({
  project: one(projects, {
    fields: [okrGoals.projectId],
    references: [projects.id],
  }),
  parent: one(okrGoals, {
    fields: [okrGoals.parentGoalId],
    references: [okrGoals.id],
    relationName: "parentGoal",
  }),
  children: many(okrGoals, { relationName: "parentGoal" }),
  keyResults: many(okrKeyResults),
  updates: many(okrUpdates),
  links: many(okrLinks),
}));

export const okrKeyResultsRelations = relations(okrKeyResults, ({ one, many }) => ({
  goal: one(okrGoals, {
    fields: [okrKeyResults.goalId],
    references: [okrGoals.id],
  }),
  updates: many(okrUpdates),
}));

export const okrUpdatesRelations = relations(okrUpdates, ({ one }) => ({
  goal: one(okrGoals, {
    fields: [okrUpdates.goalId],
    references: [okrGoals.id],
  }),
  keyResult: one(okrKeyResults, {
    fields: [okrUpdates.keyResultId],
    references: [okrKeyResults.id],
  }),
  user: one(users, {
    fields: [okrUpdates.userId],
    references: [users.id],
  }),
}));

export const okrLinksRelations = relations(okrLinks, ({ one }) => ({
  goal: one(okrGoals, {
    fields: [okrLinks.goalId],
    references: [okrGoals.id],
  }),
  ticket: one(tickets, {
    fields: [okrLinks.ticketId],
    references: [tickets.id],
  }),
  project: one(projects, {
    fields: [okrLinks.projectId],
    references: [projects.id],
  }),
}));
