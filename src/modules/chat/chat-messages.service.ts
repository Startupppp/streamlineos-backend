import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  chatAttachments,
  chatChannels,
  chatChannelMembers,
  chatMessages,
  users,
  organizationMembers,
} from "../../db/schema";
import type { ChatAttachmentPayload, PersistedMessage } from "./chat-message.types";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { resolveMentionedUserIds } from "./chat-mentions";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { AblyService } from "../realtime/ably.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { SendMessageInput } from "./dto/chat.schemas";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { CHAT_MESSAGE_FANOUT_EVENT } from "./chat-fanout-outbox";
import { MESSAGE_FANOUT_PROVIDER, type MessageFanoutProvider } from "./message-fanout.interface";

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
    private readonly replyReminders: ChatReplyRemindersService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly entities: EntityReferenceService,
    @Inject(MESSAGE_FANOUT_PROVIDER) private readonly fanout: MessageFanoutProvider,
  ) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  private async isMember(
    channelId: number,
    orgId: string,
    membershipId?: number | null,
  ): Promise<boolean> {
    if (!membershipId) return false;
    const m = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
      columns: { id: true },
    });
    return Boolean(m);
  }

  async send(channelId: number, userId: string, orgId: string, body: SendMessageInput) {
    const senderMembershipId = await this.resolveMembershipId(orgId, userId);
    if (
      senderMembershipId === null ||
      !(await this.isMember(channelId, orgId, senderMembershipId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    const sanitizedContent = body.content
      ? body.content.replace(/<[^>]+>/g, "").slice(0, 10000)
      : null;

    if (!sanitizedContent?.trim() && (!body.attachments || body.attachments.length === 0))
      throw new BadRequestException("Message must have content or attachments");

    if (body.attachments && body.attachments.length > 0) {
      const { maxAttachmentSizeMb } = await this.orgSettings.getSettings(orgId);
      const maxBytes = maxAttachmentSizeMb * 1024 * 1024;
      const oversized = body.attachments.find((a) => a.fileSize > maxBytes);
      if (oversized)
        throw new BadRequestException(
          `Attachment "${oversized.fileName}" exceeds the ${maxAttachmentSizeMb}MB limit for this organization`,
        );
    }

    const mentionedUserIds = await resolveMentionedUserIds(this.db, {
      orgId,
      channelId,
      senderId: userId,
      content: body?.content ?? "",
      mentionedUserIds: body?.mentionedUserIds,
    });

    const fanoutEventId = randomUUID();
    const { message, insertedAttachments, senderName, senderImage, channelType } =
      await this.db.transaction(async (tx) => {
        const [channel] = await tx
          .select({ id: chatChannels.id, type: chatChannels.type })
          .from(chatChannels)
          .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
          .limit(1);

        if (!channel) throw new NotFoundException("Channel not found");

        const [senderRow] = await tx
          .select({ name: users.name, image: users.image })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const [updatedChannel] = await tx
          .update(chatChannels)
          .set({
            lastMessageAt: new Date(),
            updatedAt: new Date(),
            messageCount: sql`${chatChannels.messageCount} + 1`,
          })
          .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
          .returning({ position: chatChannels.messageCount });

        const channelPosition = updatedChannel?.position ?? 0;

        const [created] = await tx
          .insert(chatMessages)
          .values({
            orgId,
            channelId,
            senderId: userId,
            senderMembershipId,
            content: sanitizedContent?.trim() || null,
            replyToId: body.replyToId,
            metadata: body.metadata ?? null,
            channelPosition,
          })
          .returning();

        let attachmentRows: ChatAttachmentPayload[] = [];
        if (body.attachments && body.attachments.length > 0) {
          attachmentRows = await tx
            .insert(chatAttachments)
            .values(
              body.attachments.map((a) => ({
                orgId,
                messageId: created.id,
                fileName: a.fileName,
                fileUrl: a.fileUrl,
                fileKey: a.fileKey,
                fileSize: a.fileSize,
                mimeType: a.mimeType,
              })),
            )
            .returning();
        }

        await tx
          .update(chatChannelMembers)
          .set({ archivedAt: null })
          .where(eq(chatChannelMembers.channelId, channelId));

        await OutboxWriter.emit(tx, {
          eventId: fanoutEventId,
          organizationId: orgId,
          aggregateType: "chat.message",
          aggregateId: String(created.id),
          aggregateVersion: created.id,
          eventType: CHAT_MESSAGE_FANOUT_EVENT,
          occurredAt: created.createdAt,
          payload: {
            orgId,
            channelId,
            channelType: channel.type ?? null,
            message: created,
            content: body?.content ?? null,
            mentionedUserIds,
            attachments: attachmentRows,
            strippedMetadata: strippedReferenceMetadata(created.metadata),
            senderName: senderRow?.name ?? null,
            senderImage: senderRow?.image ?? null,
          },
        });

        return {
          message: created,
          insertedAttachments: attachmentRows,
          senderName: senderRow?.name ?? null,
          senderImage: senderRow?.image ?? null,
          channelType: channel.type ?? null,
        };
      });

    const deferred = () =>
      runInNewTenantTransaction(this.db, orgId, async () => {
        await this.cache.invalidateNamespace(`chat:unread:${orgId}`);
        await this.replyReminders.scheduleForMessage(orgId, channelId, message.id, userId);
      }).catch((error: unknown) => {
        logger.error("chat message side effects failed", {
          orgId,
          channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    const realtime = () =>
      this.fanout
        .dispatchRealtime(
          {
            orgId,
            channelId,
            channelType,
            message,
            content: body?.content ?? null,
            mentionedUserIds,
            attachments: insertedAttachments,
            strippedMetadata: strippedReferenceMetadata(message.metadata),
            senderName,
            senderImage,
          },
          {
            producerEventId: fanoutEventId,
            idempotencyKey: `outbox:${fanoutEventId}:chat-message:${orgId}:${message.id}`,
          },
        )
        .catch((error: unknown) => {
          logger.error("chat realtime publish failed", {
            orgId,
            channelId,
            messageId: message.id,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });

    if (!registerAfterCommit(realtime)) void realtime();
    if (!registerAfterCommit(deferred)) void deferred();

    return message;
  }

  async edit(messageId: number, userId: string, orgId: string, content: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.orgId, orgId), eq(chatMessages.isDeleted, false)),
    });
    if (!message) throw new NotFoundException("Message not found");

    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (
      membershipId === null ||
      !(await this.isMember(message.channelId, orgId, membershipId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    if (
      message.senderMembershipId !== null && message.senderMembershipId !== undefined
        ? message.senderMembershipId !== membershipId
        : message.senderId !== userId
    )
      throw new ForbiddenException("You can only edit your own messages");

    const updatedAt = new Date();
    await this.db
      .update(chatMessages)
      .set({ content: content.trim(), isEdited: true, updatedAt })
      .where(
        and(
          eq(chatMessages.id, messageId),
          membershipId !== null && membershipId !== undefined
            ? eq(chatMessages.senderMembershipId, membershipId)
            : eq(chatMessages.senderId, userId),
        ),
      );

    void this.ably.publishChatEvent(orgId, message.channelId, "message:updated", {
      id: messageId,
      channelId: message.channelId,
      content: content.trim(),
      isEdited: true,
      updatedAt: updatedAt.toISOString(),
    });

    return { ok: true };
  }

  async remove(messageId: number, userId: string, isOrgAdmin: boolean, orgId: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.orgId, orgId), eq(chatMessages.isDeleted, false)),
    });
    if (!message) throw new NotFoundException("Message not found");

    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (
      membershipId === null ||
      !(await this.isMember(message.channelId, orgId, membershipId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    if (
      !isOrgAdmin &&
      (message.senderMembershipId !== null && message.senderMembershipId !== undefined
        ? message.senderMembershipId !== membershipId
        : message.senderId !== userId)
    )
      throw new ForbiddenException("You can only delete your own messages");

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, message.channelId),
        ),
      );

    void this.ably.publishChatEvent(orgId, message.channelId, "message:deleted", {
      id: messageId,
      channelId: message.channelId,
    });

    return { ok: true };
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
          eq(chatMessages.orgId, orgId),
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
    const senderMembershipId = await this.resolveMembershipId(orgId, senderId);

    const { message, senderName } = await this.db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ id: chatChannels.id })
        .from(chatChannels)
        .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
        .limit(1);

      if (!channel) throw new NotFoundException("Channel not found");

      const [senderRow] = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, senderId))
        .limit(1);

      const [updatedChannel] = await tx
        .update(chatChannels)
        .set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          messageCount: sql`${chatChannels.messageCount} + 1`,
        })
        .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
        .returning({ position: chatChannels.messageCount });

      const channelPosition = updatedChannel?.position ?? 0;

      const [created] = await tx
        .insert(chatMessages)
        .values({
          orgId,
          channelId,
          senderId,
          senderMembershipId,
          content,
          messageType: "system",
          metadata,
          channelPosition,
        })
        .returning();

      return { message: created, senderName: senderRow?.name ?? null };
    });

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
      .catch((error: unknown) => {
        logger.error("ably: publishChatMessage (system message) failed", {
          orgId,
          channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
      });
  }
}
