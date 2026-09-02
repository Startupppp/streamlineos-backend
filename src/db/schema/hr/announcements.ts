import { boolean, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const announcements = pgTable("announcements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  targetType: text("target_type").default("ALL").notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  publishAt: timestamp("publish_at"),
  expiresAt: timestamp("expires_at"),
  status: text("status").default("DRAFT").notNull(),
  readCount: integer("read_count").default(0).notNull(),
  attachmentUrls: jsonb("attachment_urls").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_announcements_org_id").on(table.orgId, table.id),
  index("idx_announcements_org_status").on(table.orgId, table.status),
  index("idx_announcements_org_pinned").on(table.orgId, table.isPinned),
]);

export const announcementTargets = pgTable("announcement_targets", {
  id: serial("id").primaryKey(),
  announcementId: integer("announcement_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.announcementId], foreignColumns: [announcements.orgId, announcements.id], name: "fk_announcement_targets_announcement_id_org" }).onDelete("cascade"),
  unique("uniq_announcement_targets_org_id").on(table.orgId, table.id),
  index("idx_announcement_targets_announcement").on(table.announcementId),
  index("idx_announcement_targets_org_type_target").on(table.orgId, table.targetType, table.targetId),
]);

export const announcementReads = pgTable("announcement_reads", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  announcementId: integer("announcement_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  readAt: timestamp("read_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.announcementId], foreignColumns: [announcements.orgId, announcements.id], name: "fk_announcement_reads_announcement_id_org" }).onDelete("cascade"),
  uniqueIndex("idx_announcement_reads_unique").on(table.announcementId, table.userId),
  index("idx_announcement_reads_announcement").on(table.announcementId),
  index("idx_announcement_reads_user").on(table.userId),
  index("idx_announcement_reads_org_user").on(table.orgId, table.userId),
]);
