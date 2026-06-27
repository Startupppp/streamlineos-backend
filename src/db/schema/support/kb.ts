import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbSpaces } from "../kb/spaces";

export const kbArticleStatusEnum = pgEnum("kb_article_status", ["draft", "in_review", "published", "archived"]);
export const kbArticleVisibilityEnum = pgEnum("kb_article_visibility", ["public", "internal"]);

export const kbCategories = pgTable(
  "kb_categories",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    spaceId: integer("space_id").references(() => kbSpaces.id, { onDelete: "cascade" }),
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
    uniqueIndex("uniq_kb_categories_org_slug").on(table.orgId, table.slug),
    index("idx_kb_categories_space").on(table.spaceId),
    index("idx_kb_categories_parent").on(table.parentId),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "fk_kb_categories_parent",
    }).onDelete("set null"),
  ],
);

export const kbArticles = pgTable(
  "kb_articles",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    categoryId: integer("category_id").references(() => kbCategories.id, { onDelete: "set null" }),
    spaceId: integer("space_id").references(() => kbSpaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    excerpt: text("excerpt"),
    content: text("content").default("").notNull(),
    contentText: text("content_text").default("").notNull(),
    status: kbArticleStatusEnum("status").default("draft").notNull(),
    visibility: kbArticleVisibilityEnum("visibility").default("internal").notNull(),
    authorId: text("author_id"),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    views: integer("views").default(0).notNull(),
    helpfulCount: integer("helpful_count").default(0).notNull(),
    notHelpfulCount: integer("not_helpful_count").default(0).notNull(),
    tags: text("tags").array(),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    reviewIntervalDays: integer("review_interval_days"),
    lastVerifiedAt: timestamp("last_verified_at"),
    publishedAt: timestamp("published_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_articles_org_slug").on(table.orgId, table.slug),
    index("idx_kb_articles_org_status").on(table.orgId, table.status),
    index("idx_kb_articles_org_category").on(table.orgId, table.categoryId),
    index("idx_kb_articles_space").on(table.spaceId),
  ],
);

export const kbArticleFeedback = pgTable(
  "kb_article_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    helpful: boolean("helpful").notNull(),
    comment: text("comment"),
    visitorId: text("visitor_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_article_feedback_article").on(table.articleId),
  ],
);

export const kbCategoriesRelations = relations(kbCategories, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbCategories.orgId], references: [organizations.id] }),
  articles: many(kbArticles),
}));

export const kbArticlesRelations = relations(kbArticles, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbArticles.orgId], references: [organizations.id] }),
  category: one(kbCategories, { fields: [kbArticles.categoryId], references: [kbCategories.id] }),
  feedback: many(kbArticleFeedback),
}));

export const kbArticleFeedbackRelations = relations(kbArticleFeedback, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleFeedback.articleId], references: [kbArticles.id] }),
}));
