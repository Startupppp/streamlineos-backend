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
    unique("uniq_kb_tags_org_id").on(table.orgId, table.id),
  ],
);

export const kbArticleTags = pgTable(
  "kb_article_tags",
  {
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").notNull(),
    tagId: integer("tag_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.articleId, table.tagId] }),
    index("idx_kb_article_tags_org_tag").on(table.orgId, table.tagId),
    foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_article_tags_org_article" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.tagId], foreignColumns: [kbTags.orgId, kbTags.id], name: "fk_kb_article_tags_org_tag" }).onDelete("cascade"),
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
