import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  projectStatusEnum,
  stateGroupEnum,
  cycleStatusEnum,
  moduleStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { deals } from "../crm/deals";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  key: text("key").notNull().unique(),
  clientId: text("client_id").references(() => users.id),
  managerId: text("manager_id").references(() => users.id),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  status: projectStatusEnum("status").default("ACTIVE").notNull(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
  budget: decimal("budget", { precision: 15, scale: 2 }),
  settings: jsonb("settings").$type<{
    modules: {
      sprints: boolean;
      epics: boolean;
      timeTracking: boolean;
      wiki: boolean;
    };
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_projects_org_status").on(table.orgId, table.status),
  index("idx_projects_manager").on(table.managerId),
  index("idx_projects_deal").on(table.dealId),
]);

export const sprints = pgTable("sprints", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  goal: text("goal"),
  status: text("status").default("PLANNED").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_sprints_project_status").on(table.projectId, table.status),
]);

export const customStates = pgTable("custom_states", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#3B82F6"),
  group: stateGroupEnum("group").notNull(),
  sequence: integer("sequence").notNull().default(0),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_custom_states_project").on(table.projectId),
  index("idx_custom_states_org").on(table.orgId),
]);

export const cycles = pgTable("cycles", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: cycleStatusEnum("status").default("draft").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_cycles_project").on(table.projectId),
  index("idx_cycles_org_status").on(table.orgId, table.status),
]);

export const modules = pgTable("modules", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: moduleStatusEnum("status").default("backlog").notNull(),
  leadId: text("lead_id").references(() => users.id),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_modules_project").on(table.projectId),
  index("idx_modules_org").on(table.orgId),
]);

export const moduleLinks = pgTable("module_links", {
  id: serial("id").primaryKey(),
  moduleId: integer("module_id").references(() => modules.id, { onDelete: "cascade" }).notNull(),
  linkedModuleId: integer("linked_module_id").references(() => modules.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_module_links").on(table.moduleId, table.linkedModuleId),
]);

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: jsonb("config").$type<{ filters: Record<string, unknown>; columns: string[] }>(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  isScheduled: boolean("is_scheduled").default(false).notNull(),
  scheduleConfig: jsonb("schedule_config").$type<{ frequency: string; recipients: string[] }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_reports_org_type").on(table.orgId, table.type),
]);

export const projectTemplates = pgTable("project_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").default("GENERAL").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_project_templates_org").on(table.orgId),
]);

export const projectTemplateTickets = pgTable("project_template_tickets", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => projectTemplates.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").default("TASK").notNull(),
  priority: text("priority").default("MEDIUM").notNull(),
  estimatedHours: decimal("estimated_hours", { precision: 8, scale: 2 }),
  order: integer("order").notNull().default(0),
  phase: text("phase"),
}, (table) => [
  index("idx_project_template_tickets_template").on(table.templateId),
]);
