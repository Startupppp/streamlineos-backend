import { AuditService } from "../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../db/drizzle.module";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { logger } from "../../common/logger/logger.service";
import {
  messageFanoutIdempotencyKey,
  type FanoutDeliveryContext,
  type FanoutInput,
} from "./message-fanout.interface";

type FanoutChannel = "push" | "dm_notification" | "mention_notification";

export interface FanoutDeferredDeps {
  db: Db;
  effects: ExternalEffectLedger;
  webPush: WebPushService;
  notifications: ChatNotificationsService;
  audit: AuditService;
}

function recordFanoutFailure(
  orgId: string,
  channelId: number,
  senderId: string,
  messageId: number,
  channel: FanoutChannel,
  err: unknown,
  audit: AuditService,
): void {
  try {
    audit.log({
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

/**
 * Push and notification delivery is intentionally retryable. The chat message outbox consumer
 * calls this function, so a rejected task causes the event to be retried or dead-lettered by the
 * common relay instead of being lost behind a log line.
 */
export async function runDeferredFanout(
  input: FanoutInput,
  context: FanoutDeliveryContext | undefined,
  deps: FanoutDeferredDeps,
): Promise<void> {
  const { db, effects, webPush, notifications, audit } = deps;
  const {
    orgId,
    channelId,
    channelType,
    message,
    mentionedUserIds,
    senderName,
  } = input;

  const failures: unknown[] = [];
  const idempotencyKey =
    context?.idempotencyKey ?? messageFanoutIdempotencyKey(input);
  const producerEventId = context?.producerEventId ?? idempotencyKey;
  const runEffect = (channel: FanoutChannel, send: () => Promise<void>) =>
    effects
      .execute(
        {
          organizationId: orgId,
          producerEventId,
          effectKey: `${idempotencyKey}:${channel}`,
          effectType: `chat.${channel}`,
          providerIdempotency: "STABLE_KEY_PROPAGATED",
        },
        () => runInNewTenantTransaction(db, orgId, async () => send()),
      )
      .then(() => undefined);
  const tasks: Promise<void>[] = [
    runEffect("push", () =>
      webPush.sendToChannelMembers(
        orgId,
        channelId,
        input.senderUserId ?? "",
        { category: "CHAT" },
        `${idempotencyKey}:push`,
      ),
    ).catch((err: unknown) => {
      logger.error("chat: push fan-out failed", {
        orgId,
        channelId,
        error: err instanceof Error ? err.message : "unknown",
      });
      recordFanoutFailure(
        orgId,
        channelId,
        input.senderUserId ?? "",
        message.id,
        "push",
        err,
        audit,
      );
      failures.push(err);
    }),
  ];

  if (channelType === "DIRECT")
    tasks.push(
      runEffect("dm_notification", () =>
        notifications.publishNewMessageNotification(
          orgId,
          channelId,
          {
            id: message.id,
            senderUserId: input.senderUserId ?? null,
            senderName,
          },
          channelType,
          `${idempotencyKey}:dm_notification`,
        ),
      ).catch((err: unknown) => {
        logger.error("chat: DM notification failed", {
          orgId,
          channelId,
          error: err instanceof Error ? err.message : "unknown",
        });
        recordFanoutFailure(
          orgId,
          channelId,
          input.senderUserId ?? "",
          message.id,
          "dm_notification",
          err,
          audit,
        );
        failures.push(err);
      }),
    );

  if (mentionedUserIds && mentionedUserIds.length > 0)
    tasks.push(
      runEffect("mention_notification", () =>
        notifications.publishMentionNotification(
          orgId,
          channelId,
          {
            id: message.id,
            senderUserId: input.senderUserId ?? null,
            senderName: senderName ?? "",
          },
          mentionedUserIds,
          `${idempotencyKey}:mention_notification`,
        ),
      ).catch((err: unknown) => {
        logger.error("chat: mention notification failed", {
          orgId,
          channelId,
          error: err instanceof Error ? err.message : "unknown",
        });
        recordFanoutFailure(
          orgId,
          channelId,
          input.senderUserId ?? "",
          message.id,
          "mention_notification",
          err,
          audit,
        );
        failures.push(err);
      }),
    );

  await Promise.all(tasks);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `chat fan-out failed in ${failures.length} channel(s)`,
    );
  }
}
