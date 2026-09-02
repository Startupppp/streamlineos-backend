import { foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
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

export const projectPortfolios = build.table("project_portfolios", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
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
  index("idx_project_portfolios_org_status").on(t.orgId, t.status).where(sql`deleted_at IS NULL`),
  unique("uniq_project_portfolios_org_id").on(t.orgId, t.id),
]);

export const projectPrograms = build.table("project_programs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  portfolioId: integer("portfolio_id"),
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
  foreignKey({ columns: [t.orgId, t.portfolioId], foreignColumns: [projectPortfolios.orgId, projectPortfolios.id], name: "fk_project_programs_org_portfolio" }).onDelete("set null"),
  index("idx_project_programs_org_status").on(t.orgId, t.status).where(sql`deleted_at IS NULL`),
  index("idx_project_programs_portfolio").on(t.portfolioId),
  unique("uniq_project_programs_org_id").on(t.orgId, t.id),
]);

export const portfolioProjects = build.table("portfolio_projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  portfolioId: integer("portfolio_id").notNull(),
  projectId: integer("project_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_portfolio_projects_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.portfolioId], foreignColumns: [projectPortfolios.orgId, projectPortfolios.id], name: "fk_portfolio_projects_org_portfolio" }).onDelete("cascade"),
  uniqueIndex("uq_portfolio_projects").on(t.portfolioId, t.projectId),
  index("idx_portfolio_projects_project").on(t.projectId),
  unique("uniq_portfolio_projects_org_id").on(t.orgId, t.id),
]);

export const programProjects = build.table("program_projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  programId: integer("program_id").notNull(),
  projectId: integer("project_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_program_projects_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.programId], foreignColumns: [projectPrograms.orgId, projectPrograms.id], name: "fk_program_projects_org_program" }).onDelete("cascade"),
  uniqueIndex("uq_program_projects").on(t.programId, t.projectId),
  index("idx_program_projects_project").on(t.projectId),
  unique("uniq_program_projects_org_id").on(t.orgId, t.id),
]);
