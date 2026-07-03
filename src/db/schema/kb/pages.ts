import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbSpaces } from "./spaces";

export const kbPages = pgTable(
  "kb_pages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    spaceId: integer("space_id").references(() => kbSpaces.id, { onDelete: "set null" }),
    parentPageId: integer("parent_page_id"),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    coverImage: text("cover_image"),
    content: jsonb("content").$type<Record<string, unknown>>(),
    contentText: text("content_text"),
    sortOrder: integer("sort_order").notNull().default(0),
    isLocked: boolean("is_locked").default(false).notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    lastEditedById: text("last_edited_by_id").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: text("deleted_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
    visibility: text("visibility").notNull().default("org").$type<"private" | "org" | "public">(),
    publicToken: text("public_token"),
    status: text("status").notNull().default("draft").$type<"draft" | "in_review" | "published" | "archived">(),
    contentType: text("content_type").notNull().default("note").$type<"note" | "sop" | "policy" | "support_article" | "troubleshooting" | "decision_record" | "meeting_notes" | "runbook" | "project_brief" | "playbook">(),
    trustState: text("trust_state").notNull().default("unverified").$type<"unverified" | "verified" | "verification_expired">(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    verifiedById: text("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verifiedUntil: timestamp("verified_until", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    publicSlug: text("public_slug"),
  },
  (table) => [
    index("idx_kb_pages_org_parent_sort").on(table.orgId, table.parentPageId, table.sortOrder),
    index("idx_kb_pages_org_deleted").on(table.orgId, table.deletedAt),
    index("idx_kb_pages_org_updated").on(table.orgId, table.updatedAt),
    index("idx_kb_pages_parent").on(table.parentPageId),
    uniqueIndex("uniq_kb_pages_public_token").on(table.publicToken),
    index("idx_kb_pages_org_status").on(table.orgId, table.status),
    index("idx_kb_pages_org_next_review").on(table.orgId, table.nextReviewAt),
    uniqueIndex("uniq_kb_pages_org_public_slug").on(table.orgId, table.publicSlug).where(sql`${table.publicSlug} IS NOT NULL`),
  ],
);

export const kbPageFavorites = pgTable(
  "kb_page_favorites",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    sortOrder: integer("sort_order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_favorites_page_user").on(table.pageId, table.userId),
    index("idx_kb_page_favorites_org_user").on(table.orgId, table.userId),
  ],
);

export const kbPageVisits = pgTable(
  "kb_page_visits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    visitedAt: timestamp("visited_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_visits_page_user").on(table.pageId, table.userId),
    index("idx_kb_page_visits_org_user_visited").on(table.orgId, table.userId, table.visitedAt),
  ],
);

export const kbPageLinks = pgTable(
  "kb_page_links",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    sourcePageId: integer("source_page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    targetPageId: integer("target_page_id").references(() => kbPages.id, { onDelete: "cascade" }).notNull(),
    targetType: text("target_type").notNull().default("page"),
    targetId: text("target_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_links_source_target").on(table.sourcePageId, table.targetPageId),
    index("idx_kb_page_links_org_target").on(table.orgId, table.targetPageId),
  ],
);

export const kbPagesRelations = relations(kbPages, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbPages.orgId], references: [organizations.id] }),
  space: one(kbSpaces, { fields: [kbPages.spaceId], references: [kbSpaces.id] }),
  createdBy: one(users, { fields: [kbPages.createdById], references: [users.id], relationName: "page_created_by" }),
  lastEditedBy: one(users, { fields: [kbPages.lastEditedById], references: [users.id], relationName: "page_last_edited_by" }),
  favorites: many(kbPageFavorites),
  visits: many(kbPageVisits),
  outboundLinks: many(kbPageLinks, { relationName: "source_page_links" }),
  inboundLinks: many(kbPageLinks, { relationName: "target_page_links" }),
}));

export const kbPageFavoritesRelations = relations(kbPageFavorites, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageFavorites.pageId], references: [kbPages.id] }),
  user: one(users, { fields: [kbPageFavorites.userId], references: [users.id] }),
}));

export const kbPageVisitsRelations = relations(kbPageVisits, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageVisits.pageId], references: [kbPages.id] }),
  user: one(users, { fields: [kbPageVisits.userId], references: [users.id] }),
}));

export const kbPageLinksRelations = relations(kbPageLinks, ({ one }) => ({
  sourcePage: one(kbPages, { fields: [kbPageLinks.sourcePageId], references: [kbPages.id], relationName: "source_page_links" }),
  targetPage: one(kbPages, { fields: [kbPageLinks.targetPageId], references: [kbPages.id], relationName: "target_page_links" }),
}));
