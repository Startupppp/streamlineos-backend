import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  primaryKey,
  unique,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { kbPages } from "./pages";

export const kbTags = pgTable(
  "kb_tags",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_tags_org_slug").on(table.orgId, table.slug),
    unique("uniq_kb_tags_org_id").on(table.orgId, table.id),
  ],
);

export const kbPageTags = pgTable(
  "kb_page_tags",
  {
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").notNull(),
    tagId: integer("tag_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.pageId, table.tagId] }),
    index("idx_kb_page_tags_org_tag").on(table.orgId, table.tagId),
    foreignKey({ columns: [table.orgId, table.pageId], foreignColumns: [kbPages.orgId, kbPages.id], name: "fk_kb_page_tags_org_page" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.tagId], foreignColumns: [kbTags.orgId, kbTags.id], name: "fk_kb_page_tags_org_tag" }).onDelete("cascade"),
  ],
);

export const kbTagsRelations = relations(kbTags, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbTags.orgId], references: [organizations.id] }),
  pageTags: many(kbPageTags),
}));

export const kbPageTagsRelations = relations(kbPageTags, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageTags.pageId], references: [kbPages.id] }),
  tag: one(kbTags, { fields: [kbPageTags.tagId], references: [kbTags.id] }),
}));
