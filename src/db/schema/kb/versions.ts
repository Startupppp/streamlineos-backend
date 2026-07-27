import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { kbArticles } from "../support/kb";

export const kbArticleVersions = pgTable(
  "kb_article_versions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    content: text("content").default("").notNull(),
    excerpt: text("excerpt"),
    changeSummary: text("change_summary"),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_article_versions").on(table.articleId, table.versionNumber),
    index("idx_kb_article_versions_org_article").on(table.orgId, table.articleId),
    unique("uniq_kb_article_versions_org_id").on(table.orgId, table.id),
  ],
);

export const kbArticleVersionsRelations = relations(kbArticleVersions, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleVersions.articleId], references: [kbArticles.id] }),
  author: one(users, { fields: [kbArticleVersions.authorId], references: [users.id] }),
}));
