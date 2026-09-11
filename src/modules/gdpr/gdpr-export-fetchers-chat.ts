import { and, asc, eq, gt } from "drizzle-orm";
import {
  chatAttachments,
  chatChannelMembers,
  chatMessageReactions,
  chatMessages,
  chatPinnedMessages,
  chatReplyReminders,
  chatSavedMessages,
  organizationMembers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchChatChannelMembers(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatChannelMembers.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(chatChannelMembers.id, afterId));
  return db
    .select({
      id: chatChannelMembers.id,
      channelId: chatChannelMembers.channelId,
      role: chatChannelMembers.role,
      joinedAt: chatChannelMembers.joinedAt,
      archivedAt: chatChannelMembers.archivedAt,
    })
    .from(chatChannelMembers)
    .innerJoin(
      organizationMembers,
      eq(chatChannelMembers.membershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatChannelMembers.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatMessages(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatMessages.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(chatMessages.id, afterId));
  return db
    .select({
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      content: chatMessages.content,
      replyToId: chatMessages.replyToId,
      isEdited: chatMessages.isEdited,
      isDeleted: chatMessages.isDeleted,
      messageType: chatMessages.messageType,
      actionStatus: chatMessages.actionStatus,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .innerJoin(
      organizationMembers,
      eq(chatMessages.senderMembershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatMessages.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatReactions(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatMessageReactions.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(chatMessageReactions.id, afterId));
  return db
    .select({
      id: chatMessageReactions.id,
      messageId: chatMessageReactions.messageId,
      emoji: chatMessageReactions.emoji,
      createdAt: chatMessageReactions.createdAt,
    })
    .from(chatMessageReactions)
    .innerJoin(
      organizationMembers,
      eq(chatMessageReactions.membershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatMessageReactions.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatAttachments(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatAttachments.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(chatAttachments.id, afterId));
  return db
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      fileName: chatAttachments.fileName,
      fileSize: chatAttachments.fileSize,
      mimeType: chatAttachments.mimeType,
      createdAt: chatAttachments.createdAt,
    })
    .from(chatAttachments)
    .innerJoin(
      chatMessages,
      and(
        eq(chatAttachments.orgId, chatMessages.orgId),
        eq(chatAttachments.messageId, chatMessages.id),
      ),
    )
    .innerJoin(
      organizationMembers,
      eq(chatMessages.senderMembershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatAttachments.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatPins(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatPinnedMessages.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(chatPinnedMessages.id, afterId));
  return db
    .select({
      id: chatPinnedMessages.id,
      channelId: chatPinnedMessages.channelId,
      messageId: chatPinnedMessages.messageId,
      pinnedAt: chatPinnedMessages.pinnedAt,
    })
    .from(chatPinnedMessages)
    .innerJoin(
      organizationMembers,
      eq(chatPinnedMessages.pinnedByMembershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatPinnedMessages.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatSaves(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatSavedMessages.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(chatSavedMessages.id, afterId));
  return db
    .select({
      id: chatSavedMessages.id,
      messageId: chatSavedMessages.messageId,
      savedAt: chatSavedMessages.savedAt,
    })
    .from(chatSavedMessages)
    .innerJoin(
      organizationMembers,
      eq(chatSavedMessages.membershipId, organizationMembers.id),
    )
    .where(and(...conditions))
    .orderBy(asc(chatSavedMessages.id))
    .limit(BATCH_SIZE);
}

export async function fetchChatReminders(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(chatReplyReminders.orgId, orgId),
    eq(organizationMembers.userId, userId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(chatReplyReminders.id, afterId));
  return db
    .select({
      id: chatReplyReminders.id,
      channelId: chatReplyReminders.channelId,
      messageId: chatReplyReminders.messageId,
      remindAt: chatReplyReminders.remindAt,
      sentAt: chatReplyReminders.sentAt,
      cancelledAt: chatReplyReminders.cancelledAt,
      createdAt: chatReplyReminders.createdAt,
    })
    .from(chatReplyReminders)
    .innerJoin(
      organizationMembers,
      and(
        eq(chatReplyReminders.orgId, organizationMembers.orgId),
        eq(chatReplyReminders.recipientMembershipId, organizationMembers.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(chatReplyReminders.id))
    .limit(BATCH_SIZE);
}
