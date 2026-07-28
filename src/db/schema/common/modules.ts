import { pgTable, text, boolean, integer, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const modulesCatalog = pgTable(
  "modules_catalog",
  {
    moduleKey: text("module_key").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    isCore: boolean("is_core").notNull().default(false),
    isPaidOnly: boolean("is_paid_only").notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    status: text("status").notNull().default("ACTIVE"),
  },
  (table) => [
    check("modules_catalog_key_format", sql`${table.moduleKey} ~ '^[a-z][a-z0-9_-]*$'`),
  ],
);

export type ModuleCatalogEntry = typeof modulesCatalog.$inferSelect;
