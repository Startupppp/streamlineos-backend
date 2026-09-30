import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  chatAttachments,
  chatChannels,
  chatChannelMembers,
  chatMessages,
  users,
} from "../../db/schema";
import type { ChatAttachmentPayload, PersistedMessage } from "./chat-message.types";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import { logger } from "../../common/logger/logger.service";
import { resolveMentionedUserIds } from "./chat-mentions";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { AblyService } from "../realtime/ably.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { SendMessageInput } from "./dto/chat.schemas";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { CHAT_MESSAGE_FANOUT_EVENT } from "./chat-fanout-outbox";
import { MESSAGE_FANOUT_PROVIDER, type MessageFanoutProvider } from "./message-fanout.interface";
import { resolveMembershipId } from "./chat-membership-lookup";
import {
  actorFromStanding,
  assertChannelMember,
  assertEntityAccess,
} from "./chat-channel-authorization";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { CHAT_MESSAGE_CLIENT_KEY_CONFLICT } from "./chat-message-conflict-target";
import { StorageService } from "../storage/storage.service";

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

class DuplicateSendError extends Error {}

@Injectable()
export class ChatMessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly ably: AblyService,
    private readonly replyReminders: ChatReplyRemindersService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly storage: StorageService,
    private readonly entities: EntityReferenceService,
    @Inject(MESSAGE_FANOUT_PROVIDER) private readonly fanout: MessageFanoutProvider,
  ) {}

  private findByClientKey(orgId: string, channelId: number, clientKey: string) {
    return this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.clientKey, clientKey),
      ),
    });
  }

  private async requireReplyTargetInChannel(
    executor: Db | TenantTx,
    orgId: string,
    channelId: number,
    messageId: number,
  ): Promise<void> {
    const target = await executor.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
      columns: { id: true },
    });

    if (!target) throw new NotFoundException("Message not found");
  }

  async send(channelId: number, userId: string, orgId: string, body: SendMessageInput) {
    const standing = await assertChannelMember(this.db, channelId, userId, orgId);
    const senderMembershipId = standing.membershipId;
    await assertEntityAccess(
      this.entities,
      standing,
      actorFromStanding(orgId, userId, standing),
      "Channel not found",
    );

    // A retry of a send whose response was lost must return the original message, not
    // post a second one. Checked after membership so it cannot be used as a probe.
    if (body.clientKey) {
      const replayed = await this.findByClientKey(orgId, channelId, body.clientKey);
      if (replayed) return replayed;
    }

    // Stored verbatim: clients render it as text, and the one HTML sink (the reply
    // reminder email) escapes it. A tag strip here turned "a<b and c>d" into "ad".
    const sanitizedContent = body.content ? body.content.slice(0, 10000) : null;

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

      const orgPrefix = `${orgId}/`;
      for (const a of body.attachments) {
        if (!this.storage.isValidFileKey(a.fileKey) || !a.fileKey.startsWith(orgPrefix))
          throw new BadRequestException(
            `Attachment "${a.fileName}" has an invalid or cross-tenant key`,
          );
      }
    }

    const mentionedUserIds = await resolveMentionedUserIds(this.db, {
      orgId,
      channelId,
      senderId: userId,
      content: body?.content ?? "",
      mentionedUserIds: body?.mentionedUserIds,
    });

    const fanoutEventId = randomUUID();
    let sendResult;
    try {
      sendResult = await this.db.transaction(async (tx) => {
        const [channel] = await tx
          .select({ id: chatChannels.id, type: chatChannels.type, isArchived: chatChannels.isArchived })
          .from(chatChannels)
          .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)))
          .limit(1);

        if (!channel) throw new NotFoundException("Channel not found");
        if (channel.isArchived) throw new ForbiddenException("Channel is archived");

        if (body.replyToId !== undefined)
          await this.requireReplyTargetInChannel(tx, orgId, channelId, body.replyToId);

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
            senderMembershipId,
            content: sanitizedContent?.trim() || null,
            replyToId: body.replyToId,
            metadata: body.metadata ?? null,
            clientKey: body.clientKey ?? null,
            channelPosition,
          })
          .onConflictDoNothing(CHAT_MESSAGE_CLIENT_KEY_CONFLICT)
          .returning();

        // Two retries racing past the pre-check both reach here; the partial unique lets
        // exactly one insert and the loser replays the winner's row.
        if (!created) throw new DuplicateSendError();

        // The sender has read what they just posted. GREATEST so a slower concurrent send
        // committing later cannot rewind the cursor.
        await tx
          .update(chatChannelMembers)
          .set({
            lastReadPosition: sql`GREATEST(${chatChannelMembers.lastReadPosition}, ${channelPosition})`,
          })
          .where(
            and(
              eq(chatChannelMembers.orgId, orgId),
              eq(chatChannelMembers.channelId, channelId),
              eq(chatChannelMembers.membershipId, senderMembershipId),
            ),
          );

        let attachmentRows: ChatAttachmentPayload[] = [];
        if (body.attachments && body.attachments.length > 0) {
          const inserted = await tx
            .insert(chatAttachments)
            .values(
              body.attachments.map((a) => ({
                orgId,
                messageId: created.id,
                fileName: a.fileName,
                fileUrl: "",
                fileKey: a.fileKey,
                fileSize: a.fileSize,
                mimeType: a.mimeType,
              })),
            )
            .returning();
          attachmentRows = inserted.map(({ id, fileName, fileKey, fileSize, mimeType }) => ({
            id,
            fileName,
            fileUrl: "",
            fileKey,
            fileSize,
            mimeType,
          }));
        }

        // `isNotNull(archivedAt)` is what turns this from an O(members) write into a
        // no-op in the overwhelmingly common case. Without it every single message
        // rewrote EVERY member row of the channel and held a row lock on each until
        // commit: 5,000 row updates and 5,000 locks per message in a 5,000-member
        // channel, two concurrent sends serialising on the whole roster, and every
        // markRead / mute / favourite on that channel queueing behind an in-flight send.
        // Table bloat grew as messages x members. The predicate does not change what the
        // statement means — a row with `archived_at` already NULL is set to NULL — it
        // only stops the rows that need nothing from being written.
        await tx
          .update(chatChannelMembers)
          .set({ archivedAt: null })
          .where(
            and(
              eq(chatChannelMembers.orgId, orgId),
              eq(chatChannelMembers.channelId, channelId),
              isNotNull(chatChannelMembers.archivedAt),
            ),
          );

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
            senderUserId: userId,
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
    } catch (error: unknown) {
      if (error instanceof DuplicateSendError && body.clientKey) {
        const winner = await this.findByClientKey(orgId, channelId, body.clientKey);
        if (winner) return winner;
      }
      throw error;
    }
    const { message, insertedAttachments, senderName, senderImage, channelType } = sendResult;

    const deferWork = async () => {
      await this.replyReminders.scheduleForMessage(orgId, channelId, message.id, userId, senderMembershipId);
    };

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
            senderUserId: userId,
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
    if (!registerAfterCommit(deferWork)) {
      void runInNewTenantTransaction(this.db, orgId, deferWork).catch((error: unknown) => {
        logger.error("chat message side effects failed", {
          orgId,
          channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    }

    return message;
  }

  async sendThreadReply(
    channelId: number,
    parentMessageId: number,
    userId: string,
    orgId: string,
    body: SendMessageInput,
  ) {
    await this.requireReplyTargetInChannel(this.db, orgId, channelId, parentMessageId);

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
    const senderMembershipId = await resolveMembershipId(this.db, orgId, senderId);

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
        senderId,
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
