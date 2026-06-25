import { pgTable, pgEnum, text, serial, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { tickets, ticketComments } from "./tasks";

export const ticketActivityActionEnum = pgEnum("ticket_activity_action", [
  "created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "title_changed",
  "sprint_changed",
  "due_date_changed",
  "comment_added",
  "label_changed",
]);

export const ticketActivityLog = pgTable("ticket_activity_log", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: ticketActivityActionEnum("action").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ticket_activity_log_ticket").on(table.ticketId),
]);

export const ticketCommentMentions = pgTable("ticket_comment_mentions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  commentId: integer("comment_id").references(() => ticketComments.id, { onDelete: "cascade" }).notNull(),
  mentionedUserId: text("mentioned_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ticket_comment_mentions_comment").on(table.commentId),
  uniqueIndex("uniq_ticket_comment_mentions_comment_user").on(table.commentId, table.mentionedUserId),
]);

export const ticketActivityLogRelations = relations(ticketActivityLog, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketActivityLog.ticketId], references: [tickets.id] }),
  organization: one(organizations, { fields: [ticketActivityLog.orgId], references: [organizations.id] }),
  user: one(users, { fields: [ticketActivityLog.userId], references: [users.id] }),
}));

export const ticketCommentMentionsRelations = relations(ticketCommentMentions, ({ one }) => ({
  comment: one(ticketComments, { fields: [ticketCommentMentions.commentId], references: [ticketComments.id] }),
  organization: one(organizations, { fields: [ticketCommentMentions.orgId], references: [organizations.id] }),
  mentionedUser: one(users, { fields: [ticketCommentMentions.mentionedUserId], references: [users.id] }),
}));
