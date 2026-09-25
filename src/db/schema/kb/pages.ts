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
  unique,
  check,
  customType,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "../build";
import { kbSpaces } from "./spaces";
import { kbCategories } from "../support/kb";

export type KbPageContent = Record<string, unknown> | Record<string, unknown>[];

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const kbPages = pgTable(
  "kb_pages",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    spaceId: integer("space_id"),
    parentPageId: integer("parent_page_id"),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    coverImage: text("cover_image"),
    content: jsonb("content").$type<KbPageContent>(),
    contentText: text("content_text"),
    fts: tsvector("fts").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')`,
    ),
    sortOrder: integer("sort_order").notNull().default(0),
    isLocked: boolean("is_locked").default(false).notNull(),
    createdById: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByMembershipId: integer("created_by_membership_id"),
    lastEditedById: text("last_edited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastEditedByMembershipId: integer("last_edited_by_membership_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: text("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedByMembershipId: integer("deleted_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    aclRevision: integer("acl_revision").notNull().default(1),
    contentRevision: integer("content_revision").notNull().default(1),
    visibility: text("visibility")
      .notNull()
      .default("org")
      .$type<"private" | "org" | "public">(),
    publicToken: text("public_token"),
    publicTokenHash: text("public_token_hash"),
    publicTokenRevision: integer("public_token_revision").notNull().default(1),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "in_review" | "published" | "archived">(),
    contentType: text("content_type")
      .notNull()
      .default("note")
      .$type<
        | "note"
        | "sop"
        | "policy"
        | "support_article"
        | "troubleshooting"
        | "decision_record"
        | "meeting_notes"
        | "runbook"
        | "project_brief"
        | "playbook"
      >(),
    trustState: text("trust_state")
      .notNull()
      .default("unverified")
      .$type<"unverified" | "verified" | "verification_expired">(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerMembershipId: integer("owner_membership_id"),
    verifiedById: text("verified_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedByMembershipId: integer("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedUntil: timestamp("verified_until", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    publicSlug: text("public_slug"),
    projectId: integer("project_id"),
    externalId: text("external_id"),
    externalSource: text("external_source"),
    slug: text("slug"),
    excerpt: text("excerpt"),
    categoryId: integer("category_id"),
    views: integer("views").default(0),
    helpfulCount: integer("helpful_count").default(0),
    notHelpfulCount: integer("not_helpful_count").default(0),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    reviewIntervalDays: integer("review_interval_days"),
    publishedAt: timestamp("published_at"),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [
    index("idx_kb_pages_org_parent_sort")
      .on(table.orgId, table.parentPageId, table.sortOrder)
      .where(sql`deleted_at IS NULL`),
    index("idx_kb_pages_project_id").on(table.projectId),
    index("idx_kb_pages_org_deleted").on(table.orgId, table.deletedAt),
    index("idx_kb_pages_org_updated")
      .on(table.orgId, table.updatedAt)
      .where(sql`deleted_at IS NULL`),
    index("idx_kb_pages_parent").on(table.parentPageId),
    uniqueIndex("uniq_kb_pages_public_token").on(table.publicToken),
    uniqueIndex("uniq_kb_pages_public_token_hash")
      .on(table.publicTokenHash)
      .where(sql`${table.publicTokenHash} IS NOT NULL`),
    index("idx_kb_pages_org_status")
      .on(table.orgId, table.status)
      .where(sql`deleted_at IS NULL`),
    index("idx_kb_pages_org_next_review")
      .on(table.orgId, table.nextReviewAt)
      .where(sql`deleted_at IS NULL AND next_review_at IS NOT NULL`),
    uniqueIndex("uniq_kb_pages_org_public_slug")
      .on(table.orgId, table.publicSlug)
      .where(sql`${table.publicSlug} IS NOT NULL`),
    uniqueIndex("uniq_kb_pages_external_ref")
      .on(table.orgId, table.externalSource, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    check(
      "chk_kb_pages_external_ref_paired",
      sql`(${table.externalId} IS NULL) = (${table.externalSource} IS NULL)`,
    ),
    uniqueIndex("uniq_kb_pages_org_slug_ref")
      .on(table.orgId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
    index("idx_kb_pages_fts").using("gin", table.fts),
    unique("uniq_kb_pages_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.spaceId],
      foreignColumns: [kbSpaces.orgId, kbSpaces.id],
      name: "fk_kb_pages_org_space",
    }),
    foreignKey({
      columns: [table.orgId, table.parentPageId],
      foreignColumns: [table.orgId, table.id],
      name: "fk_kb_pages_org_parent",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: "fk_kb_pages_org_project",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_pages_org_created_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.lastEditedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_pages_org_edited_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.deletedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_pages_org_deleted_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_pages_org_owner_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.verifiedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_pages_org_verified_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.categoryId],
      foreignColumns: [kbCategories.orgId, kbCategories.id],
      name: "fk_kb_pages_org_category",
    }).onDelete("set null"),
  ],
);

export const kbPageFavorites = pgTable(
  "kb_page_favorites",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pageId: integer("page_id").notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    sortOrder: integer("sort_order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_favorites_page_user").on(
      table.pageId,
      table.userId,
    ),
    uniqueIndex("uniq_kb_page_favorites_page_membership").on(
      table.orgId,
      table.pageId,
      table.membershipId,
    ),
    index("idx_kb_page_favorites_org_user").on(table.orgId, table.userId),
    index("idx_kb_page_favorites_org_membership_sort").on(
      table.orgId,
      table.membershipId,
      table.sortOrder,
      table.createdAt,
    ),
    unique("uniq_kb_page_favorites_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_favorites_org_page",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_page_favorites_org_membership",
    }).onDelete("cascade"),
  ],
);

export const kbPageVisits = pgTable(
  "kb_page_visits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pageId: integer("page_id").notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    visitedAt: timestamp("visited_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_visits_page_user").on(table.pageId, table.userId),
    uniqueIndex("uniq_kb_page_visits_page_membership").on(
      table.orgId,
      table.pageId,
      table.membershipId,
    ),
    index("idx_kb_page_visits_org_user_visited").on(
      table.orgId,
      table.userId,
      table.visitedAt,
    ),
    index("idx_kb_page_visits_org_membership_visited").on(
      table.orgId,
      table.membershipId,
      table.visitedAt,
    ),
    unique("uniq_kb_page_visits_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_visits_org_page",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_page_visits_org_membership",
    }).onDelete("cascade"),
  ],
);

export const kbPageLinks = pgTable(
  "kb_page_links",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sourcePageId: integer("source_page_id").notNull(),
    targetPageId: integer("target_page_id"),
    targetType: text("target_type").notNull().default("page"),
    targetId: text("target_id"),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_links_source_target").on(
      table.sourcePageId,
      table.targetPageId,
    ),
    uniqueIndex("uniq_kb_page_links_org_source_record")
      .on(table.orgId, table.sourcePageId, table.targetType, table.targetId)
      .where(sql`${table.targetId} IS NOT NULL`),
    index("idx_kb_page_links_org_target").on(table.orgId, table.targetPageId),
    unique("uniq_kb_page_links_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.sourcePageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_links_org_source",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.targetPageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_links_org_target",
    }).onDelete("cascade"),
  ],
);

export const kbPagesRelations = relations(kbPages, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [kbPages.orgId],
    references: [organizations.id],
  }),
  space: one(kbSpaces, {
    fields: [kbPages.spaceId],
    references: [kbSpaces.id],
  }),
  createdBy: one(users, {
    fields: [kbPages.createdById],
    references: [users.id],
    relationName: "page_created_by",
  }),
  lastEditedBy: one(users, {
    fields: [kbPages.lastEditedById],
    references: [users.id],
    relationName: "page_last_edited_by",
  }),
  favorites: many(kbPageFavorites),
  visits: many(kbPageVisits),
  outboundLinks: many(kbPageLinks, { relationName: "source_page_links" }),
  inboundLinks: many(kbPageLinks, { relationName: "target_page_links" }),
}));

export const kbPageFavoritesRelations = relations(
  kbPageFavorites,
  ({ one }) => ({
    page: one(kbPages, {
      fields: [kbPageFavorites.pageId],
      references: [kbPages.id],
    }),
    user: one(users, {
      fields: [kbPageFavorites.userId],
      references: [users.id],
    }),
    membership: one(organizationMembers, {
      fields: [kbPageFavorites.membershipId],
      references: [organizationMembers.id],
    }),
  }),
);

export const kbPageVisitsRelations = relations(kbPageVisits, ({ one }) => ({
  page: one(kbPages, {
    fields: [kbPageVisits.pageId],
    references: [kbPages.id],
  }),
  user: one(users, { fields: [kbPageVisits.userId], references: [users.id] }),
  membership: one(organizationMembers, {
    fields: [kbPageVisits.membershipId],
    references: [organizationMembers.id],
  }),
}));

export const kbPageLinksRelations = relations(kbPageLinks, ({ one }) => ({
  sourcePage: one(kbPages, {
    fields: [kbPageLinks.sourcePageId],
    references: [kbPages.id],
    relationName: "source_page_links",
  }),
  targetPage: one(kbPages, {
    fields: [kbPageLinks.targetPageId],
    references: [kbPages.id],
    relationName: "target_page_links",
  }),
}));
