
import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { chatMessageTypeEnum } from "./enums";
import { organizations, users } from "./auth";
import { deals } from "./crm";

export const chatChannels = pgTable("chat_channels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("GROUP"),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  isArchived: boolean("is_archived").default(false).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  isPrivate: boolean("is_private").default(false).notNull(),
  linkedDealId: integer("linked_deal_id").references(() => deals.id, { onDelete: "set null" }),
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_chat_channels_org").on(table.orgId),
  index("idx_chat_channels_last_msg").on(table.orgId, table.lastMessageAt),
]);

export const chatChannelMembers = pgTable("chat_channel_members", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id").references(() => chatChannels.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("MEMBER").notNull(),
  lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  mutedUntil: timestamp("muted_until"),
}, (table) => [
  uniqueIndex("uniq_channel_member").on(table.channelId, table.userId),
  index("idx_chat_members_user").on(table.userId),
  index("idx_chat_members_channel").on(table.channelId),
]);

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id").references(() => chatChannels.id, { onDelete: "cascade" }).notNull(),
  senderId: text("sender_id").references(() => users.id).notNull(),
  content: text("content"),
  replyToId: integer("reply_to_id"),
  isEdited: boolean("is_edited").default(false).notNull(),
  isDeleted: boolean("is_deleted").default(false).notNull(),
  messageType: chatMessageTypeEnum("message_type").notNull().default("text"),
  reactions: jsonb("reactions").$type<Record<string, string[]>>().default({}).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  actionStatus: text("action_status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.replyToId], foreignColumns: [table.id] }).onDelete("set null"),
  index("idx_chat_messages_channel").on(table.channelId, table.createdAt),
  index("idx_chat_messages_sender").on(table.senderId),
  index("idx_chat_messages_unread").on(table.channelId, table.isDeleted, table.createdAt),
]);

export const chatAttachments = pgTable("chat_attachments", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").references(() => chatMessages.id, { onDelete: "cascade" }).notNull(),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  fileKey: text("file_key").notNull(),
  fileSize: integer("file_size").notNull(),
  mimeType: text("mime_type").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_chat_attachments_msg").on(table.messageId),
]);

export const chatUserPresence = pgTable("chat_user_presence", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("OFFLINE").notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_chat_presence_user").on(table.userId),
  index("idx_chat_presence_org").on(table.orgId, table.status),
  index("idx_chat_presence_lastseen").on(table.orgId, table.lastSeenAt),
]);

export const chatPinnedMessages = pgTable("chat_pinned_messages", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id").references(() => chatChannels.id, { onDelete: "cascade" }).notNull(),
  messageId: integer("message_id").references(() => chatMessages.id, { onDelete: "cascade" }).notNull(),
  pinnedBy: text("pinned_by").references(() => users.id).notNull(),
  pinnedAt: timestamp("pinned_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_chat_pinned_msg").on(table.channelId, table.messageId),
  index("idx_chat_pinned_channel").on(table.channelId),
]);

export const chatSavedMessages = pgTable("chat_saved_messages", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  messageId: integer("message_id").references(() => chatMessages.id, { onDelete: "cascade" }).notNull(),
  savedAt: timestamp("saved_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_saved_message").on(table.userId, table.messageId),
  index("idx_saved_messages_user").on(table.userId),
]);

export const chatChannelsRelations = relations(chatChannels, ({ many, one }) => ({
  members: many(chatChannelMembers),
  messages: many(chatMessages),
  pins: many(chatPinnedMessages),
  huddles: many(chatHuddles),
  creator: one(users, { fields: [chatChannels.createdBy], references: [users.id] }),
}));

export const chatChannelMembersRelations = relations(chatChannelMembers, ({ one }) => ({
  channel: one(chatChannels, { fields: [chatChannelMembers.channelId], references: [chatChannels.id] }),
  user: one(users, { fields: [chatChannelMembers.userId], references: [users.id] }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one, many }) => ({
  channel: one(chatChannels, { fields: [chatMessages.channelId], references: [chatChannels.id] }),
  sender: one(users, { fields: [chatMessages.senderId], references: [users.id] }),
  attachments: many(chatAttachments),
  pins: many(chatPinnedMessages),
  replyTo: one(chatMessages, { fields: [chatMessages.replyToId], references: [chatMessages.id] }),
  savedBy: many(chatSavedMessages),
}));

export const chatAttachmentsRelations = relations(chatAttachments, ({ one }) => ({
  message: one(chatMessages, { fields: [chatAttachments.messageId], references: [chatMessages.id] }),
}));

export const chatPinnedMessagesRelations = relations(chatPinnedMessages, ({ one }) => ({
  channel: one(chatChannels, { fields: [chatPinnedMessages.channelId], references: [chatChannels.id] }),
  message: one(chatMessages, { fields: [chatPinnedMessages.messageId], references: [chatMessages.id] }),
  pinnedByUser: one(users, { fields: [chatPinnedMessages.pinnedBy], references: [users.id] }),
}));

export const chatSavedMessagesRelations = relations(chatSavedMessages, ({ one }) => ({
  user: one(users, { fields: [chatSavedMessages.userId], references: [users.id] }),
  message: one(chatMessages, { fields: [chatSavedMessages.messageId], references: [chatMessages.id] }),
}));

export const chatHuddles = pgTable("chat_huddles", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id").references(() => chatChannels.id, { onDelete: "cascade" }).notNull(),
  startedBy: text("started_by").references(() => users.id).notNull(),
  status: text("status").default("active").notNull(),
  calendarEventId: integer("calendar_event_id"),
  hasVideo: boolean("has_video").default(false).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
}, (table) => [
  index("idx_chat_huddles_channel").on(table.channelId, table.status),
]);

export const chatHuddleParticipants = pgTable("chat_huddle_participants", {
  id: serial("id").primaryKey(),
  huddleId: integer("huddle_id").references(() => chatHuddles.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  leftAt: timestamp("left_at"),
  isMuted: boolean("is_muted").default(false).notNull(),
  handRaised: boolean("hand_raised").default(false).notNull(),
}, (table) => [
  uniqueIndex("uniq_huddle_participant").on(table.huddleId, table.userId),
  index("idx_huddle_participants_huddle").on(table.huddleId),
]);

export const chatHuddlesRelations = relations(chatHuddles, ({ one, many }) => ({
  channel: one(chatChannels, { fields: [chatHuddles.channelId], references: [chatChannels.id] }),
  startedByUser: one(users, { fields: [chatHuddles.startedBy], references: [users.id] }),
  participants: many(chatHuddleParticipants),
}));

export const chatHuddleParticipantsRelations = relations(chatHuddleParticipants, ({ one }) => ({
  huddle: one(chatHuddles, { fields: [chatHuddleParticipants.huddleId], references: [chatHuddles.id] }),
  user: one(users, { fields: [chatHuddleParticipants.userId], references: [users.id] }),
}));
