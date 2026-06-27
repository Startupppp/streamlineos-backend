import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
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
  ],
);

export const kbArticleVersionsRelations = relations(kbArticleVersions, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleVersions.articleId], references: [kbArticles.id] }),
  author: one(users, { fields: [kbArticleVersions.authorId], references: [users.id] }),
}));
