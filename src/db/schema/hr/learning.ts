import { pgTable, text, serial, timestamp, boolean, decimal, integer, jsonb, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const courseCategories = pgTable("course_categories", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_course_categories_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_course_categories_org_name").on(table.orgId, table.name),
]);

export const courses = pgTable("courses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  categoryId: integer("category_id").references(() => courseCategories.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  instructorId: text("instructor_id").references(() => users.id, { onDelete: "set null" }),
  externalInstructor: text("external_instructor"),
  type: text("type").default("INTERNAL").notNull(),
  format: text("format").default("SELF_PACED").notNull(),
  durationHours: decimal("duration_hours", { precision: 6, scale: 2 }),
  prerequisites: jsonb("prerequisites").$type<number[]>().default([]).notNull(),
  thumbnailUrl: text("thumbnail_url"),
  status: text("status").default("DRAFT").notNull(),
  isMandatory: boolean("is_mandatory").default(false).notNull(),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_courses_org_id").on(table.orgId, table.id),
  index("idx_courses_org_status").on(table.orgId, table.status),
]);
