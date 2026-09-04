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
      .notNull(),
    senderMembershipId: integer("sender_membership_id"),
    content: text("content"),
    replyToId: bigint("reply_to_id", { mode: "number" }),
    isEdited: boolean("is_edited").default(false).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    messageType: chatMessageTypeEnum("message_type").notNull().default("text"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    actionStatus: text("action_status"),
    // Client-supplied so a send whose response was lost collides on retry instead of
    // inserting a second message. Nullable: callers that omit it keep prior behaviour.
    clientKey: text("client_key"),
    channelPosition: bigint("channel_position", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_chat_messages_channel").on(table.channelId, table.createdAt),
    index("idx_chat_messages_unread")
      .on(table.orgId, table.channelId, table.isDeleted, table.createdAt)
      .where(sql`is_deleted = false`),
    // TOTAL, not partial. The catalog carried `WHERE is_deleted = false` here while this
    // declaration said total (migration 1058 closed the drift by widening the catalog).
    // The predicate has to go: `ChatMessageTimelineService.list` reads a channel WITHOUT an
    // is_deleted filter because the product renders soft-deleted messages as tombstones,
    // and a partial index cannot serve that read — measured 1772.6 ms / 5,022 buffers on a
    // 5,000-message channel against 0.256 ms / 54 buffers with this index total.
    // `idx_chat_messages_unread` stays partial: all of ITS readers do filter.
    index("idx_chat_messages_channel_position").on(table.orgId, table.channelId, table.channelPosition.desc()),
    // Thread panels filter on reply_to_id and nothing else covered it: a parallel seq scan
    // of the tenant's whole message table per thread open, O(tenant) rather than O(thread)
    // — 47.4 ms / 6,904 buffers at 400,000 rows against 0.079 ms / 8 with this index.
    // Partial because the only predicate that reads it is an equality, which implies NOT
    // NULL, and most messages are not replies (16 kB partial against 3,000 kB total on the
    // measured set, same plan). Never an ON CONFLICT arbiter, so partial costs it nothing.
    index("idx_chat_messages_org_reply")
      .on(table.orgId, table.replyToId, table.channelPosition)
      .where(sql`reply_to_id IS NOT NULL`),
    uniqueIndex("uniq_chat_messages_client_key")
      .on(table.orgId, table.channelId, table.clientKey)
      .where(sql`client_key IS NOT NULL`),
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
    index("idx_chat_message_reactions_membership").on(table.orgId, table.membershipId),
    unique("uniq_chat_message_reactions_org_id").on(table.orgId, table.id),
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
      .notNull(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull(),
    pinnedByMembershipId: integer("pinned_by_membership_id"),
    pinnedAt: timestamp("pinned_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_pinned_msg").on(table.channelId, table.messageId),
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
      .notNull(),
    savedAt: timestamp("saved_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_saved_msg_membership").on(table.orgId, table.membershipId, table.messageId),
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
      .notNull(),
    messageId: bigint("message_id", { mode: "number" })
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
    // The shape the due-reminder cron actually queries: one org's PENDING reminders in
    // remind_at order. `idx_chat_reply_reminders_due` has neither the org prefix nor the
    // status, and almost every historical row satisfies `remind_at <= now()`, so the
    // planner took a parallel seq scan of every reminder in every tenant, once per org per
    // tick — 4,274 buffers against 104, measured on 500,000 rows. Partial so the index
    // holds only the working set and stays small as history grows (48 kB against 5,720 kB
    // on that data). `idx_chat_reply_reminders_due` is kept: a narrower index is not made
    // redundant by a wider one.
    index("idx_chat_reply_reminders_pending")
      .on(table.orgId, table.remindAt)
      .where(sql`sent_at IS NULL AND cancelled_at IS NULL`),
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
