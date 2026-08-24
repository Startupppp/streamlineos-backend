import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { users } from "../../db/schema";
import { logger } from "../../common/logger/logger.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import type { ChatAttachmentPayload, PersistedMessage } from "./chat-message.types";

export interface FanoutInput {
  orgId: string;
  channelId: number;
  /** Realtime publish runs first; push, DM-notification and mention-notification are concurrent and independent. */
  channelType: string | null;
  message: PersistedMessage;
  content: string | null;
  mentionedUserIds: string[] | undefined;
  attachments: ChatAttachmentPayload[];
  strippedMetadata: Record<string, unknown> | null;
}

@Injectable()
export class ChatMessageFanoutService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
  ) {}

  async dispatch(input: FanoutInput): Promise<void> {
    const { orgId, channelId, channelType, message, attachments, mentionedUserIds, strippedMetadata } = input;

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
      metadata: strippedMetadata,
      messageType: message.messageType,
      attachments,
    });

    const tasks: Promise<void>[] = [
      this.webPush
        .sendToChannelMembers(orgId, channelId, message.senderId, { category: "CHAT" })
        .catch((err: unknown) => {
          logger.error("chat: push fan-out failed", {
            orgId,
            channelId,
            error: err instanceof Error ? err.message : "unknown",
          });
        }),
    ];

    if (channelType === "DIRECT")
      tasks.push(
        this.notifications
          .publishNewMessageNotification(
            orgId,
            channelId,
            { id: message.id, senderId: message.senderId, senderName },
            channelType,
          )
          .catch((err: unknown) => {
            logger.error("chat: DM notification failed", {
              orgId,
              channelId,
              error: err instanceof Error ? err.message : "unknown",
            });
          }),
      );

    if (mentionedUserIds && mentionedUserIds.length > 0)
      tasks.push(
        this.notifications
          .publishMentionNotification(
            orgId,
            channelId,
            { id: message.id, senderId: message.senderId, senderName: senderName ?? "" },
            mentionedUserIds,
          )
          .catch((err: unknown) => {
            logger.error("chat: mention notification failed", {
              orgId,
              channelId,
              error: err instanceof Error ? err.message : "unknown",
            });
          }),
      );

    await Promise.all(tasks);
  }
}
