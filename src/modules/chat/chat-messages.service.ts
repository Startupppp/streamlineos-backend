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
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
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
};

@Injectable()
export class ChatMessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
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

    if (!body.content?.trim() && (!body.attachments || body.attachments.length === 0)) {
      throw new BadRequestException("Message must have content or attachments");
    }

    const message = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatMessages)
        .values({
          channelId,
          senderId: userId,
          content: body.content?.trim() || null,
          replyToId: body.replyToId,
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

      return created;
    });

    void this.dispatchMessageSideEffects(orgId, channelId, message).catch(() => undefined);

    return message;
  }

  private async dispatchMessageSideEffects(
    orgId: string,
    channelId: number,
    message: PersistedMessage,
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
  }

  async edit(messageId: number, userId: string, content: string) {
    await this.db
      .update(chatMessages)
      .set({ content: content.trim(), isEdited: true, updatedAt: new Date() })
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.senderId, userId)));

    return { ok: true };
  }

  async remove(messageId: number, userId: string, role: string) {
    const isAdmin = role === CEO || role === HR;

    const conditions = [eq(chatMessages.id, messageId)];
    if (!isAdmin) conditions.push(eq(chatMessages.senderId, userId));

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(and(...conditions));

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
