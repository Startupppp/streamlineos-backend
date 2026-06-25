import { pgTable, pgEnum, text, serial, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const roadmapStatusEnum = pgEnum("roadmap_status", ["planned", "in_progress", "completed", "cancelled"]);
export const feedbackStatusEnum = pgEnum("feedback_status", ["open", "planned", "in_progress", "completed", "declined"]);
export const changelogTypeEnum = pgEnum("changelog_type", ["feature", "improvement", "fix"]);

export const roadmapItems = pgTable("roadmap_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: roadmapStatusEnum("status").default("planned").notNull(),
  category: text("category"),
  isPublic: boolean("is_public").default(true).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  epicTicketId: integer("epic_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  targetQuarter: text("target_quarter"),
  sortOrder: integer("sort_order").default(0).notNull(),
  votes: integer("votes").default(0).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_roadmap_items_org_status").on(table.orgId, table.status),
]);

export const roadmapVotes = pgTable("roadmap_votes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  roadmapItemId: integer("roadmap_item_id").references(() => roadmapItems.id, { onDelete: "cascade" }).notNull(),
  voterKey: text("voter_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_roadmap_votes_item_voter").on(table.roadmapItemId, table.voterKey),
]);

export const feedbackPosts = pgTable("feedback_posts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: feedbackStatusEnum("status").default("open").notNull(),
  category: text("category"),
  votes: integer("votes").default(0).notNull(),
  submittedByName: text("submitted_by_name"),
  submittedByEmail: text("submitted_by_email"),
  linkedRoadmapItemId: integer("linked_roadmap_item_id").references(() => roadmapItems.id, { onDelete: "set null" }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_feedback_posts_org_status").on(table.orgId, table.status),
]);

export const feedbackVotes = pgTable("feedback_votes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  feedbackPostId: integer("feedback_post_id").references(() => feedbackPosts.id, { onDelete: "cascade" }).notNull(),
  voterKey: text("voter_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_feedback_votes_post_voter").on(table.feedbackPostId, table.voterKey),
]);

export const changelogEntries = pgTable("changelog_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  content: text("content").default("").notNull(),
  version: text("version"),
  type: changelogTypeEnum("type").default("feature").notNull(),
  isPublished: boolean("is_published").default(false).notNull(),
  linkedRoadmapItemId: integer("linked_roadmap_item_id").references(() => roadmapItems.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_changelog_entries_org_published").on(table.orgId, table.isPublished),
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
