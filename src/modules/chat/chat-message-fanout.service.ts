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
import { runDeferredFanout } from "./chat-fanout-deferred.helper";

export type { FanoutInput };

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

  async dispatch(
    input: FanoutInput,
    context?: FanoutDeliveryContext,
  ): Promise<void> {
    await this.dispatchRealtime(input, context);
    await this.dispatchDeferred(input, context);
  }

  /**
   * Realtime delivery is the latency-sensitive part of sending a message. It runs once from the
   * post-commit send hook; the durable outbox consumer deliberately does not repeat it.
   *
   * Mention notifications are Ably publishes (realtime by nature) and belong here so that
   * recipients are notified immediately after the message commits. The outbox consumer also
   * calls dispatchDeferred which calls publishMentionNotification — the ExternalEffectLedger
   * deduplicates per-user effects by effectKey so they are never sent twice.
   */
  async dispatchRealtime(
    input: FanoutInput,
    context?: FanoutDeliveryContext,
  ): Promise<void> {
    const {
      orgId,
      channelId,
      message,
      attachments,
      strippedMetadata,
      senderName,
      senderImage,
      mentionedUserIds,
    } = input;

    const send = () =>
      this.ably.publishChatMessage(
        orgId,
        channelId,
        {
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
          idempotencyKey:
            context?.idempotencyKey ?? messageFanoutIdempotencyKey(input),
        },
        { requireConfigured: true },
      );

    if (!context?.producerEventId) {
      await send();
      if (mentionedUserIds && mentionedUserIds.length > 0)
        await runInNewTenantTransaction(this.db, orgId, () =>
          this.notifications.publishMentionNotification(
            orgId,
            channelId,
            {
              id: message.id,
              senderUserId: input.senderUserId ?? null,
              senderName: senderName ?? "",
            },
            mentionedUserIds,
          ),
        ).catch((error: unknown) => {
          logger.error(
            "chat: mention notification failed in realtime dispatch",
            {
              orgId,
              channelId,
              error: error instanceof Error ? error.message : "unknown",
            },
          );
        });
      return;
    }

    await this.effects.execute(
      {
        organizationId: orgId,
        producerEventId: context.producerEventId,
        effectKey: `${context.idempotencyKey}:realtime`,
        effectType: "chat.realtime",
        providerIdempotency: "STABLE_KEY_PROPAGATED",
      },
      send,
    );

    if (mentionedUserIds && mentionedUserIds.length > 0)
      await this.effects.execute(
        {
          organizationId: orgId,
          producerEventId: context.producerEventId,
          effectKey: `${context.idempotencyKey}:mention_notification`,
          effectType: "chat.mention_notification",
          providerIdempotency: "STABLE_KEY_PROPAGATED",
        },
        () =>
          runInNewTenantTransaction(this.db, orgId, () =>
            this.notifications.publishMentionNotification(
              orgId,
              channelId,
              {
                id: message.id,
                senderUserId: input.senderUserId ?? null,
                senderName: senderName ?? "",
              },
              mentionedUserIds,
              `${context.idempotencyKey}:mention_notification`,
            ),
          ),
      );
  }

  async dispatchDeferred(
    input: FanoutInput,
    context?: FanoutDeliveryContext,
  ): Promise<void> {
    await runDeferredFanout(input, context, {
      db: this.db,
      effects: this.effects,
      webPush: this.webPush,
      notifications: this.notifications,
      audit: this.audit,
    });
  }
}
