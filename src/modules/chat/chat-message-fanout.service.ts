import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { resolveMentionedUserIds } from "./chat-mentions";
import type { ChatAttachmentPayload, PersistedMessage } from "./chat-message.types";

export interface MessageFanoutInput {
  orgId: string;
  channelId: number;
  channelType: string | null;
  message: PersistedMessage;
  content: string | null;
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

  async dispatch(input: MessageFanoutInput): Promise<void> {
    if (!this.ably.configured && !this.webPush.configured) return;

    const sender = await this.loadSender(input.message.senderId);

    await this.settle("realtime", () =>
      this.ably.publishChatMessage(input.orgId, input.channelId, {
        id: input.message.id,
        channelId: input.message.channelId,
        senderId: input.message.senderId,
        senderName: sender.name,
        senderImage: sender.image,
        content: input.message.content,
        createdAt: input.message.createdAt,
        replyToId: input.message.replyToId,
        metadata: input.strippedMetadata,
        messageType: input.message.messageType,
        attachments: input.attachments,
      }),
    );

    await Promise.all([
      this.settle("push", () =>
        this.webPush.sendToChannelMembers(input.channelId, input.message.senderId, {
          category: "CHAT",
          url: `/chat?channel=${input.channelId}`,
        }),
      ),
      this.settle("direct-message", () => this.notifyDirectMessage(input, sender.name)),
      this.settle("mentions", () => this.notifyMentions(input, sender.name)),
    ]);
  }

  private async loadSender(
    senderId: string,
  ): Promise<{ name: string | null; image: string | null }> {
    const [sender] = await this.db
      .select({ name: users.name, image: users.image })
      .from(users)
      .where(eq(users.id, senderId))
      .limit(1);
    return { name: sender?.name ?? null, image: sender?.image ?? null };
  }

  private async notifyDirectMessage(
    input: MessageFanoutInput,
    senderName: string | null,
  ): Promise<void> {
    if (input.channelType !== "DIRECT") return;
    await this.notifications.publishNewMessageNotification(
      input.orgId,
      input.channelId,
      { id: input.message.id, senderId: input.message.senderId, senderName },
      input.channelType,
    );
  }

  private async notifyMentions(
    input: MessageFanoutInput,
    senderName: string | null,
  ): Promise<void> {
    if (!input.content) return;
    const mentions = await resolveMentionedUserIds(this.db, {
      channelId: input.channelId,
      senderId: input.message.senderId,
      content: input.content,
    });
    if (mentions.length === 0) return;
    await this.notifications.publishMentionNotification(
      input.orgId,
      input.channelId,
      { id: input.message.id, senderId: input.message.senderId, senderName: senderName ?? "Someone" },
      mentions,
    );
  }

  private async settle(step: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      logger.error("chat fan-out step failed", {
        step,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
