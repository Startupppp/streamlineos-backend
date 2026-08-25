import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatMessageFanoutService } from "./chat-message-fanout.service";
import {
  FANOUT_DEFERRAL_PORT,
  type FanoutDeferralPort,
  type FanoutDeferredTask,
  type FanoutInput,
} from "./message-fanout.interface";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

type FanoutChannel = "push" | "dm_notification" | "mention_notification";

@Injectable()
export class QueuedMessageFanout extends ChatMessageFanoutService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(FANOUT_DEFERRAL_PORT) private readonly deferralPort: FanoutDeferralPort,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
    private readonly audit: AuditService,
  ) {
    super();
  }

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

    this.enqueue(orgId, channelId, message.senderId, message.id, "push", () =>
      this.webPush.sendToChannelMembers(orgId, channelId, message.senderId, {
        category: "CHAT",
      }),
    );

    if (channelType === "DIRECT")
      this.enqueue(orgId, channelId, message.senderId, message.id, "dm_notification", () =>
        this.notifications.publishNewMessageNotification(
          orgId,
          channelId,
          { id: message.id, senderId: message.senderId, senderName },
          channelType,
        ),
      );

    if (mentionedUserIds && mentionedUserIds.length > 0)
      this.enqueue(orgId, channelId, message.senderId, message.id, "mention_notification", () =>
        this.notifications.publishMentionNotification(
          orgId,
          channelId,
          { id: message.id, senderId: message.senderId, senderName: senderName ?? "" },
          mentionedUserIds,
        ),
      );
  }

  private enqueue(
    orgId: string,
    channelId: number,
    senderId: string,
    messageId: number,
    channel: FanoutChannel,
    work: () => Promise<void>,
  ): void {
    const task: FanoutDeferredTask = {
      orgId,
      run: () =>
        runInNewTenantTransaction(this.db, orgId, work).catch((err: unknown) => {
          logger.error(`chat: queued ${channel} fan-out failed`, {
            orgId,
            channelId,
            error: err instanceof Error ? err.message : "unknown",
          });
          this.recordFailure(orgId, channelId, senderId, messageId, channel, err);
        }),
    };
    this.deferralPort.defer(task);
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

@Injectable()
export class InMemoryFanoutDeferralPort implements FanoutDeferralPort {
  defer(task: FanoutDeferredTask): void {
    setImmediate(() => {
      void task.run().catch((err: unknown) => {
        logger.error("chat: in-memory deferral port swallowed an unexpected error", {
          orgId: task.orgId,
          error: err instanceof Error ? err.message : "unknown",
        });
      });
    });
  }
}
