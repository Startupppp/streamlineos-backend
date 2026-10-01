import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  bigint,
  smallint,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

import { blogPostStatusEnum } from "../common/enums";

/**
 * Public marketing blog. Posts are global (not org-scoped) because the public
 * `/blogs` URL has no organization context. Authorship is a standalone
 * `blog_authors` table so the blog is self-contained and does not depend on the
 * app's `users`/auth schema.
 */

export const blogAuthors = pgTable(
  "blog_authors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    email: varchar("email", { length: 320 }).unique(),
    avatar: text("avatar"),
    bio: text("bio"),
    role: varchar("role", { length: 100 }),
    twitter: varchar("twitter", { length: 100 }),
    linkedin: varchar("linkedin", { length: 200 }),
    slug: varchar("slug", { length: 120 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_blog_authors_name").on(table.name),
    uniqueIndex("uq_blog_authors_slug").on(table.slug),
  ],
);

export const blogCategories = pgTable(
  "blog_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    description: text("description"),
    color: varchar("color", { length: 7 }),
    seoTitle: varchar("seo_title", { length: 256 }),
    seoDescription: varchar("seo_description", { length: 320 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 256 }).notNull(),
    slug: varchar("slug", { length: 256 }).notNull().unique(),
    excerpt: text("excerpt").notNull(),
    content: text("content").notNull(),
    contentJson: jsonb("content_json").$type<Record<string, unknown>>(),
    coverImage: text("cover_image").notNull(),
    categoryId: uuid("category_id").references(() => blogCategories.id, {
      onDelete: "set null",
    }),
    authorId: uuid("author_id").references(() => blogAuthors.id, {
      onDelete: "set null",
    }),
    status: blogPostStatusEnum("status").default("draft").notNull(),
    isFeatured: boolean("is_featured").default(false).notNull(),
    readingTime: integer("reading_time"),
    metaTitle: varchar("meta_title", { length: 256 }),
    metaDescription: varchar("meta_description", { length: 320 }),
    publishedAt: timestamp("published_at"),
    tags: text("tags").array().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
    // Written only by the standalone blog admin (migration 1705). The legacy columns above hold
    // the PUBLISHED projection of `publishedRevisionId`; drafts live in `blog_post_revisions`.
    workingRevisionId: uuid("working_revision_id"),
    publishedRevisionId: uuid("published_revision_id"),
    scheduledRevisionId: uuid("scheduled_revision_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    scheduleVersion: integer("schedule_version").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    standfirst: text("standfirst"),
    searchText: text("search_text").default("").notNull(),
    cover: jsonb("cover").$type<BlogCoverProjection>(),
    socialImage: text("social_image"),
    ctaKey: varchar("cta_key", { length: 64 }),
    ownerEditorId: uuid("owner_editor_id"),
  },
  (table) => [
    index("idx_blog_posts_category").on(table.categoryId),
    index("idx_blog_posts_author").on(table.authorId),
    index("idx_blog_posts_status_published").on(table.status, table.publishedAt.desc()),
    index("idx_blog_posts_working_revision").on(table.workingRevisionId),
  ],
);

/** The published cover image as the admin projects it at publish time. */
export interface BlogCoverProjection {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string | null;
  credit: string | null;
  sources: { src: string; width: number; type: string }[];
}

/** Single-row contract version and publication generation, bumped by every admin publish. */
export const blogSchemaMeta = pgTable("blog_schema_meta", {
  id: smallint("id").primaryKey().default(1),
  version: integer("version").notNull(),
  publicationGeneration: bigint("publication_generation", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogRedirects = pgTable(
  "blog_redirects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourcePath: varchar("source_path", { length: 600 }).notNull().unique(),
    targetPath: varchar("target_path", { length: 600 }),
    statusCode: smallint("status_code").default(301).notNull(),
    postId: uuid("post_id").references(() => blogPosts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_blog_redirects_target").on(table.targetPath),
    index("idx_blog_redirects_post").on(table.postId),
  ],
);

/** Dedupe ledger for signed invalidation notifications from the blog admin. */
export const blogInvalidationReceipts = pgTable("blog_invalidation_receipts", {
  eventId: uuid("event_id").primaryKey(),
  postId: uuid("post_id"),
  generation: bigint("generation", { mode: "number" }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogAuthorsRelations = relations(blogAuthors, ({ many }) => ({
  posts: many(blogPosts),
}));

export const blogCategoriesRelations = relations(blogCategories, ({ many }) => ({
  posts: many(blogPosts),
}));

export const blogPostsRelations = relations(blogPosts, ({ one }) => ({
  category: one(blogCategories, {
    fields: [blogPosts.categoryId],
    references: [blogCategories.id],
  }),
  author: one(blogAuthors, {
    fields: [blogPosts.authorId],
    references: [blogAuthors.id],
  }),
}));

