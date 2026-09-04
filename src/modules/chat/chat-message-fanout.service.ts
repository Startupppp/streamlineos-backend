import { Inject, Injectable } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import {
  messageFanoutIdempotencyKey,
  type FanoutDeliveryContext,
  type FanoutInput,
  type MessageFanoutProvider,
} from "./message-fanout.interface";

export type { FanoutInput };

type FanoutChannel = "push" | "dm_notification" | "mention_notification";

@Injectable()
export class ChatMessageFanoutService implements MessageFanoutProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly notifications: ChatNotificationsService,
    private readonly audit: AuditService,
    private readonly effects: ExternalEffectLedger,
  ) {}

  async dispatch(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void> {
    await this.dispatchRealtime(input, context);
    await this.dispatchDeferred(input, context);
  }

  /**
   * Realtime delivery is the latency-sensitive part of sending a message, so it runs from the
   * post-commit send hook rather than waiting for the outbox relay.
   *
   * The durable outbox consumer DOES call this again — `chat-fanout-outbox.consumer.ts` invokes
   * `dispatchRealtime` before `dispatchDeferred` — and that is deliberate: if the process died
   * between commit and the post-commit hook, the relay is the only thing that will ever publish
   * the message. What stops the two paths from double-publishing is the `ExternalEffectLedger`,
   * which both paths consult under the same `effectKey`, not an assumption that only one of them
   * runs. The comment that used to sit here said the opposite ("the durable outbox consumer
   * deliberately does not repeat it") and would have led the next reader to remove the ledger
   * guard as redundant.
   */
  async dispatchRealtime(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void> {
    const {
      orgId,
      channelId,
      message,
      attachments,
      strippedMetadata,
      senderName,
      senderImage,
    } = input;

    const send = () => this.ably.publishChatMessage(orgId, channelId, {
      id: message.id,
      channelId: message.channelId,
      senderId: input.senderUserId ?? "",
      senderName,
      senderImage,
      content: message.content,
      createdAt: message.createdAt,
      replyToId: message.replyToId,
      metadata: strippedMetadata,
      messageType: message.messageType,
      attachments,
      idempotencyKey: context?.idempotencyKey ?? messageFanoutIdempotencyKey(input),
    }, { requireConfigured: true });
    if (!context?.producerEventId) return send();
    await this.effects.execute({
      organizationId: orgId,
      producerEventId: context.producerEventId,
      effectKey: `${context.idempotencyKey}:realtime`,
      effectType: "chat.realtime",
      providerIdempotency: "STABLE_KEY_PROPAGATED",
    }, send);
  }

  /**
   * Push and notification delivery is intentionally retryable. The chat message outbox consumer
   * calls this method, so a rejected task causes the event to be retried or dead-lettered by the
   * common relay instead of being lost behind a log line.
   */
  async dispatchDeferred(input: FanoutInput, context?: FanoutDeliveryContext): Promise<void> {
    const {
      orgId,
      channelId,
      channelType,
      message,
      mentionedUserIds,
      senderName,
    } = input;

    const failures: unknown[] = [];
    const idempotencyKey = context?.idempotencyKey ?? messageFanoutIdempotencyKey(input);
    const producerEventId = context?.producerEventId ?? idempotencyKey;
    const runEffect = (channel: FanoutChannel, send: () => Promise<void>) =>
      this.effects.execute({
        organizationId: orgId,
        producerEventId,
        effectKey: `${idempotencyKey}:${channel}`,
        effectType: `chat.${channel}`,
        providerIdempotency: "STABLE_KEY_PROPAGATED",
      }, () => runInNewTenantTransaction(this.db, orgId, async () => send())).then(() => undefined);
    const tasks: Promise<void>[] = [
      runEffect("push", () => this.webPush
        .sendToChannelMembers(orgId, channelId, input.senderUserId ?? "", { category: "CHAT" }, `${idempotencyKey}:push`))
        .catch((err: unknown) => {
          logger.error("chat: push fan-out failed", {
            orgId,
            channelId,
            error: err instanceof Error ? err.message : "unknown",
          });
          this.recordFailure(orgId, channelId, input.senderUserId ?? "", message.id, "push", err);
          failures.push(err);
        }),
    ];

    if (channelType === "DIRECT")
      tasks.push(
        runEffect("dm_notification", () => this.notifications
          .publishNewMessageNotification(
            orgId,
            channelId,
            { id: message.id, senderUserId: input.senderUserId ?? null, senderName },
            channelType,
            `${idempotencyKey}:dm_notification`,
          ))
          .catch((err: unknown) => {
            logger.error("chat: DM notification failed", {
              orgId,
              channelId,
              error: err instanceof Error ? err.message : "unknown",
            });
            this.recordFailure(orgId, channelId, input.senderUserId ?? "", message.id, "dm_notification", err);
            failures.push(err);
          }),
      );

    if (mentionedUserIds && mentionedUserIds.length > 0)
      tasks.push(
        runEffect("mention_notification", () => this.notifications
          .publishMentionNotification(
            orgId,
            channelId,
            { id: message.id, senderUserId: input.senderUserId ?? null, senderName: senderName ?? "" },
            mentionedUserIds,
            `${idempotencyKey}:mention_notification`,
          ))
          .catch((err: unknown) => {
            logger.error("chat: mention notification failed", {
              orgId,
              channelId,
              error: err instanceof Error ? err.message : "unknown",
            });
            this.recordFailure(orgId, channelId, input.senderUserId ?? "", message.id, "mention_notification", err);
            failures.push(err);
          }),
      );

    await Promise.all(tasks);
    if (failures.length > 0) {
      throw new AggregateError(failures, `chat fan-out failed in ${failures.length} channel(s)`);
    }
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
