import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatMessageTypeEnum } from "../common/enums";
import { organizations, organizationMembers } from "../common/auth";
import { chatChannels } from "./chat-channel-tables";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    senderMembershipId: integer("sender_membership_id"),
    content: text("content"),
    replyToId: bigint("reply_to_id", { mode: "number" }),
    isEdited: boolean("is_edited").default(false).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    messageType: chatMessageTypeEnum("message_type").notNull().default("text"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    actionStatus: text("action_status"),
    channelPosition: bigint("channel_position", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      columns: [table.replyToId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    index("idx_chat_messages_channel").on(table.channelId, table.createdAt),
    index("idx_chat_messages_unread")
      .on(table.orgId, table.channelId, table.isDeleted, table.createdAt)
      .where(sql`is_deleted = false`),
    index("idx_chat_messages_org").on(table.orgId),
    index("idx_chat_messages_channel_position").on(table.orgId, table.channelId, table.channelPosition),
    unique("uniq_chat_messages_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_messages_org_channel" }),
    foreignKey({ columns: [table.orgId, table.replyToId], foreignColumns: [table.orgId, table.id], name: "fk_chat_messages_org_reply" }),
    foreignKey({ columns: [table.orgId, table.senderMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_messages_org_sender_membership" }).onDelete("set null"),
  ],
);

export const chatMessageReactions = pgTable(
  "chat_message_reactions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    membershipId: integer("membership_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_message_reaction_actor_emoji").on(table.orgId, table.messageId, table.membershipId, table.emoji),
    index("idx_chat_message_reactions_message").on(table.orgId, table.messageId),
    index("idx_chat_message_reactions_membership").on(table.orgId, table.membershipId),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_message_reactions_org_message" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_message_reactions_org_membership" }),
  ],
);

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    messageId: bigint("message_id", { mode: "number" })
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    fileName: text("file_name").notNull(),
    fileUrl: text("file_url").notNull(),
    fileKey: text("file_key").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_chat_attachments_msg").on(table.messageId),
    index("idx_chat_attachments_org").on(table.orgId),
    unique("uniq_chat_attachments_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_attachments_org_message" }),
  ],
);

export const chatPinnedMessages = pgTable(
  "chat_pinned_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    messageId: bigint("message_id", { mode: "number" })
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    pinnedByMembershipId: integer("pinned_by_membership_id"),
    pinnedAt: timestamp("pinned_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_pinned_msg").on(table.channelId, table.messageId),
    index("idx_chat_pinned_channel").on(table.channelId),
    index("idx_chat_pinned_messages_org").on(table.orgId),
    unique("uniq_chat_pinned_messages_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_pins_org_channel" }),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_pins_org_message" }),
    foreignKey({ columns: [table.orgId, table.pinnedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_pinned_messages_org_pinner_membership" }).onDelete("set null"),
  ],
);

export const chatSavedMessages = pgTable(
  "chat_saved_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    messageId: bigint("message_id", { mode: "number" })
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    savedAt: timestamp("saved_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_saved_msg_membership").on(table.orgId, table.membershipId, table.messageId),
    index("idx_chat_saved_messages_org").on(table.orgId),
    unique("uniq_chat_saved_messages_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_saved_messages_org_message" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_saved_messages_org_membership" }).onDelete("cascade"),
  ],
);

export const chatReplyReminders = pgTable(
  "chat_reply_reminders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    messageId: bigint("message_id", { mode: "number" })
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    recipientMembershipId: integer("recipient_membership_id"),
    senderMembershipId: integer("sender_membership_id"),
    remindAt: timestamp("remind_at").notNull(),
    sentAt: timestamp("sent_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_reply_reminder").on(
      table.messageId,
      table.recipientMembershipId,
    ),
    index("idx_chat_reply_reminders_due").on(table.remindAt),
    index("idx_chat_reply_reminders_recipient").on(
      table.recipientMembershipId,
      table.channelId,
    ),
    unique("uniq_chat_reply_reminders_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_reply_reminders_org_channel" }),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_reply_reminders_org_message" }),
    foreignKey({ columns: [table.orgId, table.recipientMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_reply_reminders_org_recipient_membership" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.senderMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_reply_reminders_org_sender_membership" }).onDelete("set null"),
  ],
);
