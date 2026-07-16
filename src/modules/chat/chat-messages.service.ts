import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import {
  chatAttachments,
  chatChannels,
  chatChannelMembers,
  chatMessages,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { SendMessageInput } from "./dto/chat.schemas";

const CEO = "CEO";
const HR = "HR";

type PersistedMessage = {
  id: number;
  channelId: number;
  senderId: string;
  content: string | null;
  createdAt: Date;
  replyToId: number | null;
  metadata: Record<string, unknown> | null;
  messageType: "text" | "lead_submission" | "system";
};

@Injectable()
export class ChatMessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
    private readonly replyReminders: ChatReplyRemindersService,
    private readonly orgSettings: ChatOrgSettingsService,
  ) {}

  private async isMember(channelId: number, userId: string): Promise<boolean> {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    return Boolean(member);
  }

  async list(channelId: number, userId: string, cursor: number | undefined, limit: number) {
    if (!(await this.isMember(channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);

    const conditions = [eq(chatMessages.channelId, channelId)];
    if (cursor) conditions.push(lt(chatMessages.id, cursor));

    const messages = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.createdAt)],
      limit: safeLimit + 1,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    let nextCursor: number | undefined;
    if (messages.length > safeLimit) {
      const next = messages.pop();
      nextCursor = next?.id;
    }

    return { messages: messages.reverse(), nextCursor };
  }

  async poll(channelId: number, userId: string, since: Date) {
    if (!(await this.isMember(channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }

    const newMessages = await this.db.query.chatMessages.findMany({
      where: and(
        eq(chatMessages.channelId, channelId),
        gt(chatMessages.createdAt, since),
      ),
      orderBy: [desc(chatMessages.createdAt)],
      limit: 100,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    return newMessages.reverse();
  }

  async send(channelId: number, userId: string, orgId: string, body: SendMessageInput) {
    if (!(await this.isMember(channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }

    const sanitizedContent = body.content ? body.content.replace(/<[^>]+>/g, "").slice(0, 10000) : null;

    if (!sanitizedContent?.trim() && (!body.attachments || body.attachments.length === 0)) {
      throw new BadRequestException("Message must have content or attachments");
    }

    if (body.attachments && body.attachments.length > 0) {
      const { maxAttachmentSizeMb } = await this.orgSettings.getSettings(orgId);
      const maxBytes = maxAttachmentSizeMb * 1024 * 1024;
      const oversized = body.attachments.find((a) => a.fileSize > maxBytes);
      if (oversized) {
        throw new BadRequestException(
          `Attachment "${oversized.fileName}" exceeds the ${maxAttachmentSizeMb}MB limit for this organization`,
        );
      }
    }

    const message = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatMessages)
        .values({
          channelId,
          senderId: userId,
          content: sanitizedContent?.trim() || null,
          replyToId: body.replyToId,
          metadata: body.metadata ?? null,
        })
        .returning();

      if (body.attachments && body.attachments.length > 0) {
        await tx.insert(chatAttachments).values(
          body.attachments.map((a) => ({
            messageId: created.id,
            fileName: a.fileName,
            fileUrl: a.fileUrl,
            fileKey: a.fileKey,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        );
      }

      await tx
        .update(chatChannels)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(chatChannels.id, channelId));

      await tx
        .update(chatChannelMembers)
        .set({ archivedAt: null })
        .where(eq(chatChannelMembers.channelId, channelId));

      return created;
    });

    void this.cache.invalidatePattern(`chat:unread:*:${orgId}`).catch(() => undefined);
    void this.replyReminders
      .scheduleForMessage(orgId, channelId, message.id, userId)
      .catch(() => undefined);
    void this.dispatchMessageSideEffects(orgId, channelId, message, body).catch(() => undefined);

    return message;
  }

  private async dispatchMessageSideEffects(
    orgId: string,
    channelId: number,
    message: PersistedMessage,
    body: SendMessageInput,
  ): Promise<void> {
    if (!this.ably.configured && !this.webPush.configured) return;

    const [sender] = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, message.senderId))
      .limit(1);
    const senderName = sender?.name ?? null;

    await this.ably.publishChatMessage(orgId, channelId, {
      id: message.id,
      channelId: message.channelId,
      senderId: message.senderId,
      senderName,
      content: message.content,
      createdAt: message.createdAt,
      replyToId: message.replyToId,
      metadata: message.metadata,
      messageType: message.messageType,
    });

    await this.webPush.sendToChannelMembers(channelId, message.senderId, {
      title: senderName ?? "New message",
      body: message.content?.slice(0, 80) ?? "Sent an attachment",
      url: `/chat?channel=${channelId}`,
    });

    const channelData = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { type: true },
    });

    if (channelData?.type === "DIRECT") {
      await this.notifications.publishNewMessageNotification(orgId, channelId, {
        id: message.id,
        content: message.content,
        senderId: message.senderId,
        senderName,
      }, channelData.type);
    }

    if (body?.content) {
      const mentionPattern = /@([^\s@]+(?:\s[^\s@]+)*)/g;
      const matches = [...body.content.matchAll(mentionPattern)].map(m => m[1].toLowerCase());
      if (matches.length > 0) {
        const channelMembers = await this.db.query.chatChannelMembers.findMany({
          where: eq(chatChannelMembers.channelId, channelId),
          with: { user: { columns: { id: true, name: true } } },
        });
        const userId = message.senderId;
        if (matches.some(m => m === "channel" || m === "everyone" || m === "here")) {
          const memberIds = channelMembers.map(m => m.userId).filter(id => id !== userId);
          for (const memberId of memberIds) {
            await this.notifications.publishMentionNotification(orgId, channelId, {
              id: message.id, content: body.content!, senderId: userId, senderName: senderName ?? "Someone",
            }, [memberId]);
          }
        }
        for (const member of channelMembers) {
          if (!member.user || member.userId === userId) continue;
          const memberName = member.user.name?.toLowerCase() ?? "";
          if (matches.some(m => memberName.includes(m) || m.includes(memberName.split(" ")[0]))) {
            await this.notifications.publishMentionNotification(orgId, channelId, {
              id: message.id,
              content: body.content!,
              senderId: userId,
              senderName: senderName ?? "Someone",
            }, [member.userId]);
          }
        }
      }
    }
  }

  async edit(messageId: number, userId: string, content: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, messageId),
    });
    if (!message || message.isDeleted) throw new NotFoundException("Message not found");
    if (message.senderId !== userId) {
      throw new ForbiddenException("You can only edit your own messages");
    }

    await this.db
      .update(chatMessages)
      .set({ content: content.trim(), isEdited: true, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    return { ok: true };
  }

  async remove(messageId: number, userId: string, role: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, messageId),
    });
    if (!message || message.isDeleted) throw new NotFoundException("Message not found");

    const isAdmin = role === CEO || role === HR;
    if (!isAdmin && message.senderId !== userId) {
      throw new ForbiddenException("You can only delete your own messages");
    }

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    return { ok: true };
  }

  async listThreadReplies(
    parentMessageId: number,
    userId: string,
    cursor: number | undefined,
    limit: number,
  ) {
    const parentMessage = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, parentMessageId),
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    if (!parentMessage) throw new NotFoundException("Message not found");

    if (!(await this.isMember(parentMessage.channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);

    const conditions = [eq(chatMessages.replyToId, parentMessageId)];
    if (cursor) conditions.push(lt(chatMessages.id, cursor));

    const replies = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.createdAt)],
      limit: safeLimit + 1,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    let nextCursor: number | undefined;
    if (replies.length > safeLimit) {
      const next = replies.pop();
      nextCursor = next?.id;
    }

    return { parentMessage, replies: replies.reverse(), nextCursor };
  }

  async sendThreadReply(
    channelId: number,
    parentMessageId: number,
    userId: string,
    orgId: string,
    body: SendMessageInput,
  ) {
    const parentMessage = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, parentMessageId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
      columns: { id: true, channelId: true },
    });

    if (!parentMessage) throw new NotFoundException("Message not found");

    return this.send(channelId, userId, orgId, { ...body, replyToId: parentMessageId });
  }

  async sendSystemMessage(
    channelId: number,
    senderId: string,
    orgId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [message] = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatMessages)
        .values({
          channelId,
          senderId,
          content,
          messageType: "system",
          metadata,
        })
        .returning();

      await tx
        .update(chatChannels)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(chatChannels.id, channelId));

      return [created];
    });

    const [senderRow] = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, senderId))
      .limit(1);
    const senderName = senderRow?.name ?? null;

    void this.ably
      .publishChatMessage(orgId, channelId, {
        id: message.id,
        channelId: message.channelId,
        senderId: message.senderId,
        senderName,
        content: message.content,
        createdAt: message.createdAt,
        replyToId: message.replyToId,
        metadata,
        messageType: "system",
      })
      .catch(() => undefined);
  }

  async react(channelId: number, messageId: number, userId: string, emoji: string) {
    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    if (!membership) throw new ForbiddenException("You are not a member of this channel");

    const message = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
      columns: { id: true, reactions: true },
    });
    if (!message) throw new NotFoundException("Message not found");

    const current = message.reactions ?? {};

    const withoutUser: Record<string, string[]> = {};
    for (const [key, reactors] of Object.entries(current)) {
      const filtered = reactors.filter((id) => id !== userId);
      if (filtered.length > 0) withoutUser[key] = filtered;
    }

    const userHadThisEmoji = (current[emoji] ?? []).includes(userId);

    let updated: Record<string, string[]>;
    if (userHadThisEmoji) {
      updated = withoutUser;
    } else {
      const existing = withoutUser[emoji] ?? [];
      updated = { ...withoutUser, [emoji]: [...existing, userId] };
    }

    await this.db
      .update(chatMessages)
      .set({ reactions: updated, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    return { reactions: updated };
  }
}
