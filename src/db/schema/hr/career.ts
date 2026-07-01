import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const careerPaths = pgTable("career_paths", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  department: text("department"),
  levels: jsonb("levels").$type<{ title: string; level: number; skills: string[]; requirements: string[] }[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_career_paths_org").on(table.orgId, table.isActive),
]);

export const employeeCareerPlans = pgTable("employee_career_plans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  pathId: integer("path_id").references(() => careerPaths.id, { onDelete: "set null" }),
  currentLevel: integer("current_level").default(1).notNull(),
  targetRole: text("target_role"),
  targetDate: text("target_date"),
  aspirations: text("aspirations"),
  mentorId: text("mentor_id").references(() => users.id, { onDelete: "set null" }),
  milestones: jsonb("milestones").$type<{ title: string; dueDate: string; completed: boolean }[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_career_plans_user").on(table.userId),
]);
