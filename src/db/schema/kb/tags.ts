import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { kbArticles } from "../support/kb";

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
  ],
);

export const kbArticleTags = pgTable(
  "kb_article_tags",
  {
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    tagId: integer("tag_id").references(() => kbTags.id, { onDelete: "cascade" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.tagId] }),
  ],
);

export const kbTagsRelations = relations(kbTags, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbTags.orgId], references: [organizations.id] }),
  articleTags: many(kbArticleTags),
}));

export const kbArticleTagsRelations = relations(kbArticleTags, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleTags.articleId], references: [kbArticles.id] }),
  tag: one(kbTags, { fields: [kbArticleTags.tagId], references: [kbTags.id] }),
}));
