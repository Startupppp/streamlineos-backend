import { boolean, decimal, foreignKey, index, integer, pgEnum, text, timestamp, type AnyPgColumn, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";
import { contacts, crmOrganizations } from "../crm/contacts";

export const roadmapStatusEnum = pgEnum("roadmap_status", ["planned", "in_progress", "completed", "cancelled"]);
export const feedbackStatusEnum = pgEnum("feedback_status", ["open", "planned", "in_progress", "completed", "declined"]);
export const changelogTypeEnum = pgEnum("changelog_type", ["feature", "improvement", "fix"]);

export const roadmapItems = build.table("roadmap_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: roadmapStatusEnum("status").default("planned").notNull(),
  category: text("category"),
  isPublic: boolean("is_public").default(false).notNull(),
  projectId: integer("project_id"),
  epicTicketId: integer("epic_ticket_id"),
  targetQuarter: text("target_quarter"),
  sortOrder: integer("sort_order").default(0).notNull(),
  votes: integer("votes").default(0).notNull(),
  reach: integer("reach"),
  impact: integer("impact"),
  confidence: integer("confidence"),
  effort: integer("effort"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_roadmap_items_org_project" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.epicTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_roadmap_items_org_ticket" }).onDelete("set null"),
  index("idx_roadmap_items_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
  unique("uniq_roadmap_items_org_id").on(table.orgId, table.id),
]);

export const roadmapVotes = build.table("roadmap_votes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  roadmapItemId: integer("roadmap_item_id").notNull(),
  voterKey: text("voter_key").notNull(),
  voterIpHash: text("voter_ip_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.roadmapItemId], foreignColumns: [roadmapItems.orgId, roadmapItems.id], name: "fk_roadmap_votes_org_roadmap" }).onDelete("cascade"),
  uniqueIndex("uniq_roadmap_votes_item_voter").on(table.roadmapItemId, table.voterKey),
  uniqueIndex("uniq_roadmap_votes_item_ip").on(table.roadmapItemId, table.voterIpHash).where(sql`voter_ip_hash IS NOT NULL`),
  unique("uniq_roadmap_votes_org_id").on(table.orgId, table.id),
]);

export const feedbackPosts = build.table("feedback_posts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: feedbackStatusEnum("status").default("open").notNull(),
  category: text("category"),
  votes: integer("votes").default(0).notNull(),
  submittedByName: text("submitted_by_name"),
  submittedByEmail: text("submitted_by_email"),
  crmContactId: integer("crm_contact_id").references(() => contacts.id, { onDelete: "set null" }),
  crmOrganizationId: integer("crm_organization_id").references(() => crmOrganizations.id, { onDelete: "set null" }),
  accountValueSnapshot: decimal("account_value_snapshot", { precision: 15, scale: 2 }),
  linkedRoadmapItemId: integer("linked_roadmap_item_id"),
  duplicateOfId: integer("duplicate_of_id"),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.duplicateOfId], foreignColumns: [table.orgId, table.id], name: "fk_feedback_posts_org_dup" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.linkedRoadmapItemId], foreignColumns: [roadmapItems.orgId, roadmapItems.id], name: "fk_feedback_posts_org_roadmap" }).onDelete("set null"),
  index("idx_feedback_posts_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
  index("idx_feedback_posts_crm_contact").on(table.orgId, table.crmContactId).where(sql`deleted_at IS NULL`),
  index("idx_feedback_posts_crm_org").on(table.orgId, table.crmOrganizationId).where(sql`deleted_at IS NULL`),
  index("idx_feedback_posts_duplicate_of").on(table.orgId, table.duplicateOfId).where(sql`duplicate_of_id IS NOT NULL`),
  unique("uniq_feedback_posts_org_id").on(table.orgId, table.id),
]);

export const feedbackVotes = build.table("feedback_votes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  feedbackPostId: integer("feedback_post_id").notNull(),
  voterKey: text("voter_key").notNull(),
  voterIpHash: text("voter_ip_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.feedbackPostId], foreignColumns: [feedbackPosts.orgId, feedbackPosts.id], name: "fk_feedback_votes_org_post" }).onDelete("cascade"),
  uniqueIndex("uniq_feedback_votes_post_voter").on(table.feedbackPostId, table.voterKey),
  uniqueIndex("uniq_feedback_votes_post_ip").on(table.feedbackPostId, table.voterIpHash).where(sql`voter_ip_hash IS NOT NULL`),
  unique("uniq_feedback_votes_org_id").on(table.orgId, table.id),
]);

export const changelogEntries = build.table("changelog_entries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  content: text("content").default("").notNull(),
  version: text("version"),
  type: changelogTypeEnum("type").default("feature").notNull(),
  isPublished: boolean("is_published").default(false).notNull(),
  linkedRoadmapItemId: integer("linked_roadmap_item_id"),
  publishedAt: timestamp("published_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.linkedRoadmapItemId], foreignColumns: [roadmapItems.orgId, roadmapItems.id], name: "fk_changelog_entries_org_roadmap" }).onDelete("set null"),
  index("idx_changelog_entries_org_published").on(table.orgId, table.isPublished),
  unique("uniq_changelog_entries_org_id").on(table.orgId, table.id),
]);

export const roadmapItemsRelations = relations(roadmapItems, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [roadmapItems.orgId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [roadmapItems.projectId],
    references: [projects.id],
  }),
  epicTicket: one(tickets, {
    fields: [roadmapItems.epicTicketId],
    references: [tickets.id],
  }),
  itemVotes: many(roadmapVotes),
  feedbackPosts: many(feedbackPosts),
  changelogEntries: many(changelogEntries),
}));

export const roadmapVotesRelations = relations(roadmapVotes, ({ one }) => ({
  roadmapItem: one(roadmapItems, {
    fields: [roadmapVotes.roadmapItemId],
    references: [roadmapItems.id],
  }),
}));

export const feedbackPostsRelations = relations(feedbackPosts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [feedbackPosts.orgId],
    references: [organizations.id],
  }),
  linkedRoadmapItem: one(roadmapItems, {
    fields: [feedbackPosts.linkedRoadmapItemId],
    references: [roadmapItems.id],
  }),
  crmContact: one(contacts, {
    fields: [feedbackPosts.crmContactId],
    references: [contacts.id],
  }),
  crmOrganization: one(crmOrganizations, {
    fields: [feedbackPosts.crmOrganizationId],
    references: [crmOrganizations.id],
  }),
  postVotes: many(feedbackVotes),
}));

export const feedbackVotesRelations = relations(feedbackVotes, ({ one }) => ({
  feedbackPost: one(feedbackPosts, {
    fields: [feedbackVotes.feedbackPostId],
    references: [feedbackPosts.id],
  }),
}));

export const changelogEntriesRelations = relations(changelogEntries, ({ one }) => ({
  organization: one(organizations, {
    fields: [changelogEntries.orgId],
    references: [organizations.id],
  }),
  linkedRoadmapItem: one(roadmapItems, {
    fields: [changelogEntries.linkedRoadmapItemId],
    references: [roadmapItems.id],
  }),
}));
