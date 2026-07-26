import { pgTable, pgEnum, text, serial, integer, timestamp, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "./core";

export const portfolioStatusEnum = pgEnum("project_portfolio_status", [
  "active",
  "on_hold",
  "completed",
  "archived",
]);

export const portfolioHealthEnum = pgEnum("project_portfolio_health", [
  "on_track",
  "at_risk",
  "off_track",
]);

export const projectPortfolios = pgTable("project_portfolios", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  status: portfolioStatusEnum("status").notNull().default("active"),
  health: portfolioHealthEnum("health"),
  strategicGoal: text("strategic_goal"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_portfolios_org_status").on(t.orgId, t.status),
  unique("uniq_project_portfolios_org_id").on(t.orgId, t.id),
]);

export const projectPrograms = pgTable("project_programs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  portfolioId: integer("portfolio_id").references(() => projectPortfolios.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  status: portfolioStatusEnum("status").notNull().default("active"),
  health: portfolioHealthEnum("health"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_programs_org_status").on(t.orgId, t.status),
  index("idx_project_programs_portfolio").on(t.portfolioId),
  unique("uniq_project_programs_org_id").on(t.orgId, t.id),
]);

export const portfolioProjects = pgTable("portfolio_projects", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  portfolioId: integer("portfolio_id").references(() => projectPortfolios.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uq_portfolio_projects").on(t.portfolioId, t.projectId),
  index("idx_portfolio_projects_project").on(t.projectId),
  unique("uniq_portfolio_projects_org_id").on(t.orgId, t.id),
]);

export const programProjects = pgTable("program_projects", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  programId: integer("program_id").references(() => projectPrograms.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uq_program_projects").on(t.programId, t.projectId),
  index("idx_program_projects_project").on(t.projectId),
  unique("uniq_program_projects_org_id").on(t.orgId, t.id),
]);
