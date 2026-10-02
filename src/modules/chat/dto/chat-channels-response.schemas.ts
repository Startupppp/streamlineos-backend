import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import {
  CHANNEL_MEMBER_ROLES,
  NOTIFICATION_PREFERENCES,
  CHANNEL_TYPES,
} from "./chat.schemas";

const chatUserPreviewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

export const channelMemberPreviewSchema = z.object({
  id: z.number().int(),
  channelId: z.number().int(),
  userId: z.string().nullable(),
  role: z.enum(CHANNEL_MEMBER_ROLES),
  mutedUntil: nullableWireDate(),
  isFavorite: z.boolean(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES),
  user: chatUserPreviewSchema.nullable(),
});

const channelLastMessageSchema = z.object({
  content: z.string().nullable(),
  senderName: z.string().nullable(),
  createdAt: wireDate(),
});

export const channelListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(CHANNEL_TYPES),
  avatarUrl: z.string().nullable(),
  isArchived: z.boolean(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  members: z.array(channelMemberPreviewSchema),
  memberCount: z.number().int(),
  membersTruncated: z.boolean(),
  unreadCount: z.number().int(),
  lastMessage: channelLastMessageSchema.nullable(),
});

/** Exactly what `ChatChannelListService.listPublicChannels` selects, plus its two derived fields. */
export const channelPublicListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(CHANNEL_TYPES),
  description: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: wireDate(),
  lastMessageAt: wireDate(),
  memberCount: z.number().int(),
  isMember: z.boolean(),
});

const chatUserWithEmailSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string(),
});

export const channelDetailMemberSchema = z.object({
  id: z.number().int(),
  channelId: z.number().int(),
  userId: z.string().nullable(),
  role: z.enum(CHANNEL_MEMBER_ROLES),
  lastReadAt: nullableWireDate(),
  joinedAt: wireDate(),
  mutedUntil: nullableWireDate(),
  archivedAt: nullableWireDate(),
  isFavorite: z.boolean(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES),
  user: chatUserWithEmailSchema.nullable(),
});

export const channelDetailSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  type: z.enum(CHANNEL_TYPES),
  description: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isArchived: z.boolean(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  isPinned: z.boolean(),
  isPrivate: z.boolean(),
  messageCount: z.number().int(),
  lastMessageAt: wireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  members: z.array(channelDetailMemberSchema),
});

export const channelListResponseSchema = z.object({
  channels: z.array(channelListItemSchema),
  nextCursor: z.string().nullable(),
});

export const channelPublicListResponseSchema = z.object({
  channels: z.array(channelPublicListItemSchema),
  nextCursor: z.string().nullable(),
});

export const channelMembersListResponseSchema = z.object({
  members: z.array(channelDetailMemberSchema),
  nextCursor: z.number().int().nullable(),
});

const channelFileItemSchema = z.object({
  id: z.number().int(),
  messageId: z.number().int(),
  fileName: z.string(),
  fileKey: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  createdAt: wireDate(),
});

export const channelFilesResponseSchema = z.object({
  files: z.array(channelFileItemSchema),
  nextCursor: z.number().int().optional(),
});

export const channelTypingResponseSchema = z.array(
  z.object({ userId: z.string(), name: z.string() }),
);

export const channelOkSchema = z.object({ ok: z.literal(true) });

export const channelMuteResponseSchema = z.object({
  ok: z.literal(true),
  mutedUntil: wireDate(),
});

export const channelNotifPrefResponseSchema = z.object({
  ok: z.literal(true),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES),
});

export const channelSuccessSchema = z.object({ success: z.literal(true) });
