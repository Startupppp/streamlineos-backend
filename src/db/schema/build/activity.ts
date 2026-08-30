import {
  pgEnum,
  text,
  bigserial,
  bigint,
  integer,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { tickets, ticketComments } from "./tasks";
import { build, buildEvents } from "./namespaces";

export const ticketActivityActionEnum = pgEnum("ticket_activity_action", [
  "created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "title_changed",
  "sprint_changed",
  "due_date_changed",
  "comment_added",
  "comment_updated",
  "comment_deleted",
  "label_changed",
  "estimate_changed",
  "cycle_changed",
  "type_changed",
]);

export const ticketActivityLog = buildEvents.table("ticket_activity_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  userMembershipId: integer("user_membership_id"),
  action: ticketActivityActionEnum("action").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_ticket_activity_log_ticket_recent").on(table.ticketId, table.id),
  index("idx_ticket_activity_log_org_ticket").on(table.orgId, table.ticketId, table.id),
  unique("uniq_ticket_activity_log_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_ticket_activity_log_user_actor",
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("restrict"),
]);

export const ticketCommentMentions = build.table("ticket_comment_mentions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  commentId: bigint("comment_id", { mode: "number" }).references(() => ticketComments.id, { onDelete: "cascade" }).notNull(),
  mentionedUserId: text("mentioned_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  mentionedUserMembershipId: integer("mentioned_user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ticket_comment_mentions_comment").on(table.commentId),
  uniqueIndex("uniq_ticket_comment_mentions_comment_user").on(table.commentId, table.mentionedUserId),
  unique("uniq_ticket_comment_mentions_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_ticket_comment_mentions_mentioned_user_actor",
    columns: [table.orgId, table.mentionedUserMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("restrict"),
]);

export const ticketActivityLogRelations = relations(ticketActivityLog, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketActivityLog.ticketId], references: [tickets.id] }),
  organization: one(organizations, { fields: [ticketActivityLog.orgId], references: [organizations.id] }),
  user: one(users, { fields: [ticketActivityLog.userId], references: [users.id] }),
  actorMembership: one(organizationMembers, {
    fields: [ticketActivityLog.orgId, ticketActivityLog.userMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));

export const ticketCommentMentionsRelations = relations(ticketCommentMentions, ({ one }) => ({
  comment: one(ticketComments, { fields: [ticketCommentMentions.commentId], references: [ticketComments.id] }),
  organization: one(organizations, { fields: [ticketCommentMentions.orgId], references: [organizations.id] }),
  mentionedUser: one(users, { fields: [ticketCommentMentions.mentionedUserId], references: [users.id] }),
  mentionedMembership: one(organizationMembers, {
    fields: [ticketCommentMentions.orgId, ticketCommentMentions.mentionedUserMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));
