import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { kbSpaces } from "../kb/spaces";

export const kbCategories = pgTable(
  "kb_categories",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    spaceId: integer("space_id"),
    parentId: integer("parent_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    icon: text("icon"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isPublished: boolean("is_published").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_categories_org_space_slug").on(table.orgId, table.spaceId, table.slug),
    index("idx_kb_categories_space").on(table.spaceId),
    index("idx_kb_categories_parent").on(table.parentId),
    foreignKey({
      columns: [table.orgId, table.spaceId],
      foreignColumns: [kbSpaces.orgId, kbSpaces.id],
      name: "fk_kb_categories_org_space",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.parentId],
      foreignColumns: [table.orgId, table.id],
      name: "fk_kb_categories_org_parent",
    }).onDelete("set null"),
    unique("uniq_kb_categories_org_id").on(table.orgId, table.id),
  ],
);

export const kbCategoriesRelations = relations(kbCategories, ({ one }) => ({
  organization: one(organizations, { fields: [kbCategories.orgId], references: [organizations.id] }),
}));
