import { Injectable } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import type { FanoutInput, MessageFanout } from "./message-fanout.interface";

export type { FanoutInput };

type FanoutChannel = "push" | "dm_notification" | "mention_notification";

@Injectable()
export class ChatMessageFanoutService implements MessageFanout {
  constructor(
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
    private readonly audit: AuditService,
  ) {}

  async dispatch(input: FanoutInput): Promise<void> {
    const {
      orgId,
      channelId,
      channelType,
      message,
      attachments,
      mentionedUserIds,
      strippedMetadata,
      senderName,
      senderImage,
    } = input;

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
          this.recordFailure(orgId, channelId, message.senderId, message.id, "push", err);
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
            this.recordFailure(orgId, channelId, message.senderId, message.id, "dm_notification", err);
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
            this.recordFailure(orgId, channelId, message.senderId, message.id, "mention_notification", err);
          }),
      );

    await Promise.all(tasks);
  }

  private recordFailure(
    orgId: string,
    channelId: number,
    senderId: string,
    messageId: number,
    channel: FanoutChannel,
    err: unknown,
  ): void {
    try {
      this.audit.log({
        action: "chat:fanout:failure",
        userId: senderId,
        orgId,
        targetType: "chat_channel",
        targetId: String(channelId),
        result: "FAILURE",
        metadata: {
          channel,
          messageId,
          error: err instanceof Error ? err.message : "unknown",
        },
      });
    } catch {
      // Never propagate an audit failure into the send path.
    }
  }
}
