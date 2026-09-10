import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const documentTemplates = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  type: text("type").notNull().default("OFFER"),
  htmlContent: text("html_content").notNull().default(""),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_document_templates_org_id").on(table.orgId, table.id),
  index("idx_doc_templates_org").on(table.orgId, table.type),
]);

export const documentTypes = pgTable("document_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  countryCode: text("country_code"),
  isMandatory: boolean("is_mandatory").default(true).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_document_types_org_id").on(table.orgId, table.id),
  index("idx_doc_types_org_country").on(table.orgId, table.countryCode),
]);
