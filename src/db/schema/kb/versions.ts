import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { kbArticles } from "../support/kb";

export const kbArticleVersions = pgTable(
  "kb_article_versions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    content: text("content").default("").notNull(),
    excerpt: text("excerpt"),
    changeSummary: text("change_summary"),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    authorMembershipId: integer("author_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_article_versions").on(table.articleId, table.versionNumber),
    index("idx_kb_article_versions_org_article").on(table.orgId, table.articleId),
    unique("uniq_kb_article_versions_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_article_versions_org_article" }).onDelete("cascade"),
  ],
);

export const kbArticleVersionsRelations = relations(kbArticleVersions, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleVersions.articleId], references: [kbArticles.id] }),
  author: one(users, { fields: [kbArticleVersions.authorId], references: [users.id] }),
}));
