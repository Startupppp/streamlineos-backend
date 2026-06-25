import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  managerId: text("manager_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_departments_org_name").on(table.orgId, table.name),
]);

export const departmentMembers = pgTable("department_members", {
  id: serial("id").primaryKey(),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_dept_members_dept_user").on(table.departmentId, table.userId),
]);

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [departments.orgId],
    references: [organizations.id],
  }),
  members: many(departmentMembers),
}));

export const departmentMembersRelations = relations(departmentMembers, ({ one }) => ({
  department: one(departments, {
    fields: [departmentMembers.departmentId],
    references: [departments.id],
  }),
  user: one(users, {
    fields: [departmentMembers.userId],
    references: [users.id],
  }),
}));
