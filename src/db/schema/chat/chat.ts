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
import { relations, sql } from "drizzle-orm";
import { chatMessageTypeEnum } from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { deals } from "../crm";

export const chatChannels = pgTable(
  "chat_channels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("GROUP"),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    isPinned: boolean("is_pinned").default(false).notNull(),
    isPrivate: boolean("is_private").default(false).notNull(),
    linkedDealId: integer("linked_deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_chat_channels_org").on(table.orgId),
    index("idx_chat_channels_last_msg").on(table.orgId, table.lastMessageAt),
    index("idx_chat_channels_org_entity").on(
      table.orgId,
      table.entityType,
      table.entityId,
    ),
    unique("uniq_chat_channels_org_id").on(table.orgId, table.id),
  ],
);

export const chatChannelMembers = pgTable(
  "chat_channel_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    role: text("role").default("MEMBER").notNull(),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    mutedUntil: timestamp("muted_until"),
    archivedAt: timestamp("archived_at"),
    isFavorite: boolean("is_favorite").default(false).notNull(),
    notificationPreference: text("notification_preference")
      .default("DEFAULT")
      .notNull(),
  },
  (table) => [
    uniqueIndex("uniq_channel_member").on(table.channelId, table.userId),
    uniqueIndex("uniq_chat_channel_member_membership").on(table.orgId, table.channelId, table.membershipId),
    index("idx_chat_members_user").on(table.userId),
    index("idx_chat_members_channel").on(table.channelId),
    index("idx_chat_channel_members_org").on(table.orgId),
    unique("uniq_chat_channel_members_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_channel_members_org_channel" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_channel_members_org_membership" }),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    // c21-04: was integer (int4). int4 caps at 2,147,483,647, which chat reaches well inside the
    // stated two-year projection; widened while the table is still small, as SCH-001 did for
    // notifications. Every referencing message_id and the reply_to_id self-key widen with it.
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    senderId: text("sender_id")
      .references(() => users.id)
      .notNull(),
    senderMembershipId: integer("sender_membership_id"),
    content: text("content"),
    replyToId: bigint("reply_to_id", { mode: "number" }),
    isEdited: boolean("is_edited").default(false).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    messageType: chatMessageTypeEnum("message_type").notNull().default("text"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    actionStatus: text("action_status"),
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
    index("idx_chat_messages_sender").on(table.senderId),
    index("idx_chat_messages_unread")
      .on(table.orgId, table.channelId, table.isDeleted, table.createdAt)
      .where(sql`is_deleted = false`),
    index("idx_chat_messages_org").on(table.orgId),
    unique("uniq_chat_messages_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_messages_org_channel" }),
    foreignKey({ columns: [table.orgId, table.replyToId], foreignColumns: [table.orgId, table.id], name: "fk_chat_messages_org_reply" }),
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

export const chatUserPresence = pgTable(
  "chat_user_presence",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    status: text("status").default("OFFLINE").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_presence_org_user").on(table.orgId, table.userId),
    uniqueIndex("uniq_chat_presence_org_membership").on(table.orgId, table.membershipId),
    index("idx_chat_presence_org").on(table.orgId, table.status),
    index("idx_chat_presence_lastseen").on(table.orgId, table.lastSeenAt),
    unique("uniq_chat_user_presence_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_chat_user_presence_org_membership",
    }).onDelete("set null"),
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
    pinnedBy: text("pinned_by")
      .references(() => users.id)
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
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    messageId: bigint("message_id", { mode: "number" })
      .references(() => chatMessages.id, { onDelete: "cascade" })
      .notNull(),
    savedAt: timestamp("saved_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_saved_message").on(table.userId, table.messageId),
    index("idx_saved_messages_user").on(table.userId),
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
    recipientUserId: text("recipient_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    recipientMembershipId: integer("recipient_membership_id"),
    senderUserId: text("sender_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    senderMembershipId: integer("sender_membership_id"),
    remindAt: timestamp("remind_at").notNull(),
    sentAt: timestamp("sent_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_reply_reminder").on(
      table.messageId,
      table.recipientUserId,
    ),
    index("idx_chat_reply_reminders_due").on(table.remindAt),
    index("idx_chat_reply_reminders_recipient").on(
      table.recipientUserId,
      table.channelId,
    ),
    unique("uniq_chat_reply_reminders_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_reply_reminders_org_channel" }),
    foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [chatMessages.orgId, chatMessages.id], name: "fk_chat_reply_reminders_org_message" }),
    foreignKey({ columns: [table.orgId, table.recipientMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_reply_reminders_org_recipient_membership" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.senderMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_reply_reminders_org_sender_membership" }).onDelete("set null"),
  ],
);

export const chatChannelsRelations = relations(
  chatChannels,
  ({ many, one }) => ({
    members: many(chatChannelMembers),
    messages: many(chatMessages),
    pins: many(chatPinnedMessages),
    huddles: many(chatHuddles),
    creator: one(users, {
      fields: [chatChannels.createdBy],
      references: [users.id],
    }),
  }),
);

export const chatChannelMembersRelations = relations(
  chatChannelMembers,
  ({ one }) => ({
    channel: one(chatChannels, {
      fields: [chatChannelMembers.channelId],
      references: [chatChannels.id],
    }),
    user: one(users, {
      fields: [chatChannelMembers.userId],
      references: [users.id],
    }),
    membership: one(organizationMembers, {
      fields: [chatChannelMembers.membershipId],
      references: [organizationMembers.id],
    }),
  }),
);

export const chatMessagesRelations = relations(
  chatMessages,
  ({ one, many }) => ({
    channel: one(chatChannels, {
      fields: [chatMessages.channelId],
      references: [chatChannels.id],
    }),
    sender: one(users, {
      fields: [chatMessages.senderId],
      references: [users.id],
    }),
    attachments: many(chatAttachments),
    pins: many(chatPinnedMessages),
    replyTo: one(chatMessages, {
      fields: [chatMessages.replyToId],
      references: [chatMessages.id],
    }),
    savedBy: many(chatSavedMessages),
    reactions: many(chatMessageReactions),
  }),
);

export const chatMessageReactionsRelations = relations(chatMessageReactions, ({ one }) => ({
  message: one(chatMessages, { fields: [chatMessageReactions.messageId], references: [chatMessages.id] }),
  membership: one(organizationMembers, { fields: [chatMessageReactions.membershipId], references: [organizationMembers.id] }),
}));

export const chatAttachmentsRelations = relations(
  chatAttachments,
  ({ one }) => ({
    message: one(chatMessages, {
      fields: [chatAttachments.messageId],
      references: [chatMessages.id],
    }),
  }),
);

export const chatPinnedMessagesRelations = relations(
  chatPinnedMessages,
  ({ one }) => ({
    channel: one(chatChannels, {
      fields: [chatPinnedMessages.channelId],
      references: [chatChannels.id],
    }),
    message: one(chatMessages, {
      fields: [chatPinnedMessages.messageId],
      references: [chatMessages.id],
    }),
    pinnedByUser: one(users, {
      fields: [chatPinnedMessages.pinnedBy],
      references: [users.id],
    }),
  }),
);

export const chatSavedMessagesRelations = relations(
  chatSavedMessages,
  ({ one }) => ({
    user: one(users, {
      fields: [chatSavedMessages.userId],
      references: [users.id],
    }),
    message: one(chatMessages, {
      fields: [chatSavedMessages.messageId],
      references: [chatMessages.id],
    }),
  }),
);

export const chatHuddles = pgTable(
  "chat_huddles",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    startedBy: text("started_by")
      .references(() => users.id)
      .notNull(),
    startedByMembershipId: integer("started_by_membership_id"),
    status: text("status").default("active").notNull(),
    calendarEventId: integer("calendar_event_id"),
    hasVideo: boolean("has_video").default(false).notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("idx_chat_huddles_channel").on(table.channelId, table.status),
    index("idx_chat_huddles_org").on(table.orgId),
    unique("uniq_chat_huddles_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_huddles_org_channel" }),
    foreignKey({ columns: [table.orgId, table.startedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_huddles_org_starter_membership" }).onDelete("set null"),
  ],
);

export const chatHuddleParticipants = pgTable(
  "chat_huddle_participants",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    huddleId: integer("huddle_id")
      .references(() => chatHuddles.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    leftAt: timestamp("left_at"),
    isMuted: boolean("is_muted").default(false).notNull(),
    handRaised: boolean("hand_raised").default(false).notNull(),
    isCameraOff: boolean("is_camera_off").default(false).notNull(),
    isScreenSharing: boolean("is_screen_sharing").default(false).notNull(),
    isDeafened: boolean("is_deafened").default(false).notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_huddle_participant").on(table.huddleId, table.userId),
    index("idx_huddle_participants_huddle").on(table.huddleId),
    index("idx_chat_huddle_participants_org").on(table.orgId),
    unique("uniq_chat_huddle_participants_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.huddleId], foreignColumns: [chatHuddles.orgId, chatHuddles.id], name: "fk_chat_huddle_participants_org_huddle" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_huddle_participants_org_membership" }).onDelete("cascade"),
  ],
);

export const chatChannelInviteLinks = pgTable(
  "chat_channel_invite_links",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    token: text("token"),
    tokenHash: text("token_hash"),
    tokenEncrypted: text("token_encrypted"),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("uniq_chat_invite_link_token").on(table.token),
    uniqueIndex("uniq_chat_invite_link_token_hash").on(table.tokenHash),
    index("idx_chat_invite_links_channel").on(table.channelId, table.revokedAt),
    index("idx_chat_channel_invite_links_org").on(table.orgId),
    unique("uniq_chat_channel_invite_links_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_invite_links_org_channel" }),
    foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_invite_links_created_by_membership" }).onDelete("set null"),
  ],
);

export const chatChannelInviteLinksRelations = relations(
  chatChannelInviteLinks,
  ({ one }) => ({
    channel: one(chatChannels, {
      fields: [chatChannelInviteLinks.channelId],
      references: [chatChannels.id],
    }),
    createdByMembership: one(organizationMembers, {
      fields: [chatChannelInviteLinks.createdByMembershipId],
      references: [organizationMembers.id],
    }),
  }),
);

export const chatOrgSettings = pgTable(
  "chat_org_settings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    defaultNotificationPreference: text("default_notification_preference")
      .default("ALL")
      .notNull(),
    maxAttachmentSizeMb: integer("max_attachment_size_mb")
      .default(25)
      .notNull(),
    maxHuddleParticipants: integer("max_huddle_participants")
      .default(50)
      .notNull(),
    updatedByMembershipId: integer("updated_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_chat_org_settings_org").on(table.orgId),
    unique("uniq_chat_org_settings_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.updatedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_org_settings_updated_by_membership" }).onDelete("set null"),
  ],
);

export const chatHuddlesRelations = relations(chatHuddles, ({ one, many }) => ({
  channel: one(chatChannels, {
    fields: [chatHuddles.channelId],
    references: [chatChannels.id],
  }),
  startedByUser: one(users, {
    fields: [chatHuddles.startedBy],
    references: [users.id],
  }),
  participants: many(chatHuddleParticipants),
}));

export const chatHuddleParticipantsRelations = relations(
  chatHuddleParticipants,
  ({ one }) => ({
    huddle: one(chatHuddles, {
      fields: [chatHuddleParticipants.huddleId],
      references: [chatHuddles.id],
    }),
    user: one(users, {
      fields: [chatHuddleParticipants.userId],
      references: [users.id],
    }),
  }),
);
