import { relations } from "drizzle-orm";
import { users, organizationMembers } from "../common/auth";
import {
  chatChannels,
  chatChannelMembers,
  chatChannelInviteLinks,
  chatOrgSettings,
} from "./chat-channel-tables";
import {
  chatMessages,
  chatMessageReactions,
  chatAttachments,
  chatPinnedMessages,
  chatSavedMessages,
  chatReplyReminders,
} from "./chat-message-tables";
import {
  chatUserPresence,
  chatHuddles,
  chatHuddleParticipants,
} from "./chat-huddle-tables";

export {
  chatChannels,
  chatChannelMembers,
  chatChannelInviteLinks,
  chatOrgSettings,
  chatMessages,
  chatMessageReactions,
  chatAttachments,
  chatPinnedMessages,
  chatSavedMessages,
  chatReplyReminders,
  chatUserPresence,
  chatHuddles,
  chatHuddleParticipants,
};

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
