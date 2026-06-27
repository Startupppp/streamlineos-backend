import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { kbArticles } from "../support/kb";
import { kbTranslationStatusEnum } from "../enums";

export const kbArticleTranslations = pgTable(
  "kb_article_translations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    content: text("content").default("").notNull(),
    contentText: text("content_text").default("").notNull(),
    excerpt: text("excerpt"),
    status: kbTranslationStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_article_translations").on(table.articleId, table.locale),
  ],
);

export const kbArticleTranslationsRelations = relations(kbArticleTranslations, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleTranslations.articleId], references: [kbArticles.id] }),
}));
