import { Inject, Injectable } from "@nestjs/common";
import {
  chatChannelMembers,
  chatMessages,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { and, eq, inArray } from "drizzle-orm";
import { boundedMap } from "../../common/async/bounded-map";
import { logger } from "../../common/logger/logger.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import type { ExternalEffect } from "../../common/outbox/external-effect-ledger";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const SUPPRESSED_GENERAL_PREFERENCES = new Set(["NOTHING", "MENTIONS"]);

const PUBLISH_CONCURRENCY = 16;

function reportFailures(
  event: string,
  channelId: number,
  results: PromiseSettledResult<unknown>[],
): void {
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  const failed = failures.length;
  if (failed === 0) return;
  logger.error("chat notification publish failed for some recipients", {
    event,
    channelId,
    failed,
    total: results.length,
  });
  throw new AggregateError(
    failures,
    `${event} delivery failed for ${failed} recipient(s)`,
  );
}

@Injectable()
export class ChatNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly effects: ExternalEffectLedger,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async publishNewMessageNotification(
    orgId: string,
    channelId: number,
    message: {
      id: number;
      senderUserId: string | null;
      senderName: string | null;
    },
    channelType: string,
    idempotencyKey?: string,
  ) {
    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        mutedUntil: chatChannelMembers.mutedUntil,
        notificationPreference: chatChannelMembers.notificationPreference,
      })
      .from(chatChannelMembers)
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.id, chatChannelMembers.membershipId),
      )
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
        ),
      );

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const now = new Date();
    const recipients = members.filter(
      ({ userId, mutedUntil, notificationPreference }) => {
        if (message.senderUserId && userId === message.senderUserId)
          return false;
        if (mutedUntil && mutedUntil > now) return false;
        const effectivePreference =
          notificationPreference !== "DEFAULT"
            ? notificationPreference
            : defaultPreference;
        return !SUPPRESSED_GENERAL_PREFERENCES.has(effectivePreference);
      },
    );

    if (idempotencyKey) {
      const items: Array<{
        effect: ExternalEffect;
        send: () => Promise<void>;
      }> = recipients.map(({ userId }) => ({
        effect: {
          organizationId: orgId,
          producerEventId: idempotencyKey,
          effectKey: `${idempotencyKey}:${userId}`,
          effectType: "chat.notification.message",
          providerIdempotency: "STABLE_KEY_PROPAGATED",
        },
        send: () =>
          this.ably.publishToUser(
            orgId,
            userId,
            "notification:message",
            {
              channelId,
              messageId: message.id,
              senderId: message.senderUserId ?? "",
              senderName: message.senderName,
              channelType,
              idempotencyKey: `${idempotencyKey}:${userId}`,
            },
            { requireConfigured: true },
          ),
      }));
      await this.effects.executeBatch(items);
    } else {
      const delivered = await boundedMap(
        recipients,
        PUBLISH_CONCURRENCY,
        ({ userId }) =>
          this.ably.publishToUser(orgId, userId, "notification:message", {
            channelId,
            messageId: message.id,
            senderId: message.senderUserId ?? "",
            senderName: message.senderName,
            channelType,
          }),
      );
      reportFailures("notification:message", channelId, delivered);
    }

    if (channelType === "DIRECT" && recipients.length > 0) {
      const targetUserIds = recipients.map(({ userId }) => userId);
      await this.dispatch.emitNow({
        eventKey: "chat.message.direct",
        orgId,
        actorUserId: message.senderUserId ?? undefined,
        targetUserIds,
        channels: ["IN_APP"],
        entityType: "chat_message",
        entityId: String(message.id),
        link: `/chat?channel=${channelId}`,
        replayKey: idempotencyKey ? `${idempotencyKey}:inbox` : undefined,
      });
    }
  }

  async publishMentionNotification(
    orgId: string,
    channelId: number,
    message: { id: number; senderUserId: string | null; senderName: string },
    mentionedUserIds: string[],
    idempotencyKey?: string,
  ) {
    if (mentionedUserIds.length === 0) return;

    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        notificationPreference: chatChannelMembers.notificationPreference,
      })
      .from(chatChannelMembers)
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.id, chatChannelMembers.membershipId),
      )
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          inArray(organizationMembers.userId, mentionedUserIds),
        ),
      );
    const preferenceByUser = new Map(
      members.map((m) => [m.userId, m.notificationPreference]),
    );

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const recipients = mentionedUserIds.filter((userId) => {
      const pref = preferenceByUser.get(userId) ?? "DEFAULT";
      return (pref !== "DEFAULT" ? pref : defaultPreference) !== "NOTHING";
    });

    if (recipients.length === 0) return;

    if (idempotencyKey) {
      const items: Array<{
        effect: ExternalEffect;
        send: () => Promise<void>;
      }> = recipients.map((userId) => ({
        effect: {
          organizationId: orgId,
          producerEventId: idempotencyKey,
          effectKey: `${idempotencyKey}:${userId}`,
          effectType: "chat.notification.mention",
          providerIdempotency: "STABLE_KEY_PROPAGATED",
        },
        send: () =>
          this.ably.publishToUser(
            orgId,
            userId,
            "notification:mention",
            {
              channelId,
              messageId: message.id,
              senderId: message.senderUserId ?? "",
              senderName: message.senderName,
              idempotencyKey: `${idempotencyKey}:${userId}`,
            },
            { requireConfigured: true },
          ),
      }));
      await this.effects.executeBatch(items);
    } else {
      const delivered = await boundedMap(
        recipients,
        PUBLISH_CONCURRENCY,
        (userId) =>
          this.ably.publishToUser(orgId, userId, "notification:mention", {
            channelId,
            messageId: message.id,
            senderId: message.senderUserId ?? "",
            senderName: message.senderName,
          }),
      );
      reportFailures("notification:mention", channelId, delivered);
    }

    await this.dispatch.emitNow({
      eventKey: "chat.message.mention",
      orgId,
      actorUserId: message.senderUserId ?? undefined,
      targetUserIds: recipients,
      channels: ["IN_APP"],
      entityType: "chat_message",
      entityId: String(message.id),
      link: `/chat?channel=${channelId}&message=${message.id}`,
      replayKey: idempotencyKey ? `${idempotencyKey}:inbox` : undefined,
    });
  }

  async publishThreadReplyInboxNotification(
    orgId: string,
    channelId: number,
    message: { id: number; replyToId: number; senderUserId: string | null },
    idempotencyKey?: string,
  ): Promise<void> {
    const [parent] = await this.db
      .select({
        userId: organizationMembers.userId,
        notificationPreference: chatChannelMembers.notificationPreference,
        mutedUntil: chatChannelMembers.mutedUntil,
      })
      .from(chatMessages)
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.id, chatMessages.senderMembershipId),
      )
      .innerJoin(
        chatChannelMembers,
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.membershipId, organizationMembers.id),
          eq(chatChannelMembers.channelId, channelId),
        ),
      )
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.id, message.replyToId),
        ),
      )
      .limit(1);

    if (!parent) return;
    if (message.senderUserId && parent.userId === message.senderUserId) return;

    const now = new Date();
    if (parent.mutedUntil && parent.mutedUntil > now) return;

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;
    const effectivePreference =
      parent.notificationPreference !== "DEFAULT"
        ? parent.notificationPreference
        : defaultPreference;
    if (SUPPRESSED_GENERAL_PREFERENCES.has(effectivePreference)) return;

    await this.dispatch.emitNow({
      eventKey: "chat.thread.reply",
      orgId,
      actorUserId: message.senderUserId ?? undefined,
      targetUserIds: [parent.userId],
      channels: ["IN_APP"],
      entityType: "chat_message",
      entityId: String(message.id),
      link: `/chat?channel=${channelId}&message=${message.replyToId}`,
      replayKey: idempotencyKey ? `${idempotencyKey}:inbox` : undefined,
    });
  }
}
