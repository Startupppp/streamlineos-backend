import { pgTable, pgEnum, text, serial, timestamp, numeric, date, integer, foreignKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const goalLevelEnum = pgEnum("okr_goal_level", ["company", "team", "individual"]);
export const goalStatusEnum = pgEnum("okr_goal_status", ["not_started", "on_track", "at_risk", "off_track", "completed"]);
export const keyResultMetricEnum = pgEnum("okr_kr_metric", ["number", "percentage", "currency", "boolean"]);

export const okrGoals = pgTable("okr_goals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  level: goalLevelEnum("level").default("company").notNull(),
  status: goalStatusEnum("status").default("not_started").notNull(),
  progress: integer("progress").default(0).notNull(),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  parentGoalId: integer("parent_goal_id"),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.parentGoalId], foreignColumns: [table.id] }).onDelete("set null"),
  index("idx_okr_goals_org").on(table.orgId),
  index("idx_okr_goals_org_status").on(table.orgId, table.status),
  index("idx_okr_goals_parent").on(table.parentGoalId),
]);

export const okrKeyResults = pgTable("okr_key_results", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").references(() => okrGoals.id, { onDelete: "cascade" }).notNull(),
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
  index("idx_okr_key_results_goal").on(table.goalId),
]);

export const okrUpdates = pgTable("okr_updates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").references(() => okrGoals.id, { onDelete: "cascade" }).notNull(),
  keyResultId: integer("key_result_id").references(() => okrKeyResults.id, { onDelete: "set null" }),
  note: text("note"),
  previousValue: numeric("previous_value", { precision: 18, scale: 2 }),
  newValue: numeric("new_value", { precision: 18, scale: 2 }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_okr_updates_goal").on(table.goalId),
]);

export const okrLinks = pgTable("okr_links", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  goalId: integer("goal_id").references(() => okrGoals.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_okr_links_goal_ticket").on(table.goalId, table.ticketId),
  index("idx_okr_links_goal").on(table.goalId),
]);

export const okrGoalsRelations = relations(okrGoals, ({ one, many }) => ({
  owner: one(users, {
    fields: [okrGoals.ownerId],
    references: [users.id],
  }),
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
