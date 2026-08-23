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
import type { ChatAttachmentPayload } from "../realtime/dto/realtime.schemas";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { nextReactions } from "./chat-reactions";
import type { SendMessageInput } from "./dto/chat.schemas";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type {
  EntityActor,
  EntityReference,
} from "../entity-reference/entity-reference.types";

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

/**
 * A realtime publish reaches every channel member at once, so it cannot resolve
 * references per reader the way the REST paths do. It therefore carries only the
 * type and id; each client resolves the card over its own authenticated request,
 * which is where the permission check happens.
 */
function strippedReferenceMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const raw = metadata?.["entities"];
  if (!Array.isArray(raw)) return metadata;
  const entities = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const { type, id } = entry as { type?: unknown; id?: unknown };
    return { type, id };
  });
  return { ...metadata, entities };
}

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
    private readonly entities: EntityReferenceService,
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

  async list(
    channelId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const userId = actor.userId;
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

    return {
      messages: await this.withResolvedReferences(actor, messages.reverse()),
      nextCursor,
    };
  }

  /**
   * References are resolved for the reader, now — not read back from the copy
   * taken when the message was sent. A reader who never had, or has lost, access
   * to the record gets the reference back with no card.
   */
  private async withResolvedReferences<
    T extends { metadata: Record<string, unknown> | null },
  >(actor: EntityActor, messages: T[]): Promise<T[]> {
    return this.entities.withResolvedReferences(actor, messages);
  }

  async poll(channelId: number, actor: EntityActor, since: Date) {
    const userId = actor.userId;
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

    return this.withResolvedReferences(actor, newMessages.reverse());
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

    const { message, insertedAttachments } = await this.db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ id: chatChannels.id })
        .from(chatChannels)
        .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
        .limit(1);

      if (!channel) throw new NotFoundException("Channel not found");

      const [created] = await tx
        .insert(chatMessages)
        .values({
          orgId,
          channelId,
          senderId: userId,
          content: sanitizedContent?.trim() || null,
          replyToId: body.replyToId,
          metadata: body.metadata ?? null,
        })
        .returning();

      let attachmentRows: ChatAttachmentPayload[] = [];
      if (body.attachments && body.attachments.length > 0) {
        attachmentRows = await tx.insert(chatAttachments).values(
          body.attachments.map((a) => ({
            orgId,
            messageId: created.id,
            fileName: a.fileName,
            fileUrl: a.fileUrl,
            fileKey: a.fileKey,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        ).returning();
      }

      await tx
        .update(chatChannels)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(chatChannels.id, channelId));

      await tx
        .update(chatChannelMembers)
        .set({ archivedAt: null })
        .where(eq(chatChannelMembers.channelId, channelId));

      return { message: created, insertedAttachments: attachmentRows };
    });

    const deferred = () =>
      runInNewTenantTransaction(this.db, orgId, async () => {
        await this.cache.invalidateNamespace(`chat:unread:${orgId}`);
        await this.replyReminders.scheduleForMessage(
          orgId,
          channelId,
          message.id,
          userId,
        );
        await this.dispatchMessageSideEffects(
          orgId,
          channelId,
          message,
          body,
          insertedAttachments,
        );
      }).catch((error: unknown) => {
        logger.error("chat message side effects failed", {
          orgId,
          channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    if (!registerAfterCommit(deferred)) void deferred();

    return message;
  }

  private async dispatchMessageSideEffects(
    orgId: string,
    channelId: number,
    message: PersistedMessage,
    body: SendMessageInput,
    insertedAttachments: ChatAttachmentPayload[],
  ): Promise<void> {
    if (!this.ably.configured && !this.webPush.configured) return;

    const [sender] = await this.db
      .select({ name: users.name, image: users.image })
      .from(users)
      .where(eq(users.id, message.senderId))
      .limit(1);
    const senderName = sender?.name ?? null;
    const senderImage = sender?.image ?? null;

    await this.ably.publishChatMessage(orgId, channelId, {
      id: message.id,
      channelId: message.channelId,
      senderId: message.senderId,
      senderName,
      senderImage,
      content: message.content,
      createdAt: message.createdAt,
      replyToId: message.replyToId,
      metadata: strippedReferenceMetadata(message.metadata),
      messageType: message.messageType,
      attachments: insertedAttachments,
    });

    // RT-001: neither the sender's name nor the message text crosses the push
    // boundary. The client opens the channel and loads it over an authenticated
    // request. This costs the lock-screen preview deliberately — a chat message can
    // contain anything, and the push service is a third party.
    await this.webPush.sendToChannelMembers(channelId, message.senderId, {
      category: "CHAT",
      url: `/chat?channel=${channelId}`,
    });

    const channelData = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { type: true },
    });

    if (channelData?.type === "DIRECT") {
      await this.notifications.publishNewMessageNotification(orgId, channelId, {
        id: message.id,
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
          if (memberIds.length > 0) {
            await this.notifications.publishMentionNotification(orgId, channelId, {
              id: message.id, senderId: userId, senderName: senderName ?? "Someone",
            }, memberIds);
          }
        }
        const individualMentionIds: string[] = [];
        for (const member of channelMembers) {
          if (!member.user || member.userId === userId) continue;
          const memberName = member.user.name?.trim().toLowerCase() ?? "";
          if (!memberName) continue;
          const firstName = memberName.split(" ")[0] ?? "";
          if (matches.some(m => memberName.includes(m) || (firstName !== "" && m.includes(firstName)))) {
            individualMentionIds.push(member.userId);
          }
        }
        if (individualMentionIds.length > 0) {
          await this.notifications.publishMentionNotification(orgId, channelId, {
            id: message.id,
            senderId: userId,
            senderName: senderName ?? "Someone",
          }, individualMentionIds);
        }
      }
    }
  }

  async edit(messageId: number, userId: string, orgId: string, content: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.isDeleted, false)),
    });
    if (!message) throw new NotFoundException("Message not found");
    if (!(await this.isMember(message.channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException("You can only edit your own messages");
    }

    const updatedAt = new Date();
    await this.db
      .update(chatMessages)
      .set({ content: content.trim(), isEdited: true, updatedAt })
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.senderId, userId)));

    void this.ably.publishChatEvent(orgId, message.channelId, "message:updated", {
      id: messageId,
      channelId: message.channelId,
      content: content.trim(),
      isEdited: true,
      updatedAt: updatedAt.toISOString(),
    }).catch(() => undefined);

    return { ok: true };
  }

  async remove(messageId: number, userId: string, isOrgAdmin: boolean, orgId: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.isDeleted, false)),
    });
    if (!message) throw new NotFoundException("Message not found");
    if (!(await this.isMember(message.channelId, userId))) {
      throw new ForbiddenException("You are not a member of this channel");
    }

    if (!isOrgAdmin && message.senderId !== userId) {
      throw new ForbiddenException("You can only delete your own messages");
    }

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(and(eq(chatMessages.id, messageId), eq(chatMessages.channelId, message.channelId)));

    void this.ably.publishChatEvent(orgId, message.channelId, "message:deleted", {
      id: messageId,
      channelId: message.channelId,
    }).catch(() => undefined);

    return { ok: true };
  }

  async listThreadReplies(
    parentMessageId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const userId = actor.userId;
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

    const [resolvedParent] = await this.withResolvedReferences(actor, [parentMessage]);
    return {
      parentMessage: resolvedParent ?? parentMessage,
      replies: await this.withResolvedReferences(actor, replies.reverse()),
      nextCursor,
    };
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

  async readMessageContent(
    messageId: number,
    channelId: number,
    orgId: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatChannels, eq(chatMessages.channelId, chatChannels.id))
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, channelId),
          eq(chatChannels.orgId, orgId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .limit(1);

    return row?.content ?? null;
  }

  async sendSystemMessage(
    channelId: number,
    senderId: string,
    orgId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [message] = await this.db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ id: chatChannels.id })
        .from(chatChannels)
        .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
        .limit(1);

      if (!channel) throw new NotFoundException("Channel not found");

      const [created] = await tx
        .insert(chatMessages)
        .values({
          orgId,
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
        senderImage: null,
        content: message.content,
        createdAt: message.createdAt,
        replyToId: message.replyToId,
        metadata: strippedReferenceMetadata(metadata),
        messageType: "system",
        attachments: [],
      })
      .catch(() => undefined);
  }

  async react(channelId: number, messageId: number, userId: string, orgId: string, emoji: string) {
    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    if (!membership) throw new ForbiddenException("You are not a member of this channel");

    // Locked for the rest of the request transaction: without it two reactors read the
    // same snapshot and the second write erases the first.
    const [message] = await this.db
      .select({ id: chatMessages.id, reactions: chatMessages.reactions })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, channelId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .for("update")
      .limit(1);
    if (!message) throw new NotFoundException("Message not found");

    const updated = nextReactions(message.reactions ?? {}, userId, emoji);

    await this.db
      .update(chatMessages)
      .set({ reactions: updated, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    void this.ably.publishChatEvent(orgId, channelId, "reaction:updated", {
      messageId,
      channelId,
      reactions: updated,
    }).catch(() => undefined);

    return { reactions: updated };
  }
}
