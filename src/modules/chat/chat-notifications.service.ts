import { Inject, Injectable } from "@nestjs/common";
import { chatChannelMembers, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { and, eq, inArray } from "drizzle-orm";
import { boundedMap } from "../../common/async/bounded-map";
import { logger } from "../../common/logger/logger.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import type { ExternalEffect } from "../../common/outbox/external-effect-ledger";

const SUPPRESSED_GENERAL_PREFERENCES = new Set(["NOTHING", "MENTIONS"]);

/**
 * RT-007. These payloads carried the full message body. An Ably capability is granted
 * when the connection is created, so a user removed from a channel keeps receiving on a
 * subscription they already hold — and message text delivered that way never passes the
 * read endpoint's authorization at all.
 *
 * The payload is now a signal: enough to invalidate the right query and name the sender
 * for a toast, and nothing that has to be authorized. The client fetches the message
 * through the API, where access is re-checked. Nothing consumed `content` from here.
 */

const PUBLISH_CONCURRENCY = 16;

function reportFailures(
  event: string,
  channelId: number,
  results: PromiseSettledResult<unknown>[],
): void {
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  const failed = failures.length;
  if (failed === 0) return;
  logger.error("chat notification publish failed for some recipients", {
    event,
    channelId,
    failed,
    total: results.length,
  });
  throw new AggregateError(failures, `${event} delivery failed for ${failed} recipient(s)`);
}

@Injectable()
export class ChatNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly effects: ExternalEffectLedger,
  ) {}

  async publishNewMessageNotification(
    orgId: string,
    channelId: number,
    message: { id: number; senderUserId: string | null; senderName: string | null },
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
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
      .where(and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.channelId, channelId)));

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const now = new Date();
    const recipients = members.filter(({ userId, mutedUntil, notificationPreference }) => {
      if (message.senderUserId && userId === message.senderUserId) return false;
      if (mutedUntil && mutedUntil > now) return false;
      const effectivePreference =
        notificationPreference !== "DEFAULT" ? notificationPreference : defaultPreference;
      return !SUPPRESSED_GENERAL_PREFERENCES.has(effectivePreference);
    });

    if (idempotencyKey) {
      const items: Array<{ effect: ExternalEffect; send: () => Promise<void> }> = recipients.map(
        ({ userId }) => ({
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
        }),
      );
      await this.effects.executeBatch(items);
      return;
    }

    const delivered = await boundedMap(recipients, PUBLISH_CONCURRENCY, ({ userId }) =>
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
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          inArray(organizationMembers.userId, mentionedUserIds),
        ),
      );
    const preferenceByUser = new Map(members.map((m) => [m.userId, m.notificationPreference]));

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const recipients = mentionedUserIds.filter((userId) => {
      const pref = preferenceByUser.get(userId) ?? "DEFAULT";
      return (pref !== "DEFAULT" ? pref : defaultPreference) !== "NOTHING";
    });

    if (recipients.length === 0) return;

    if (idempotencyKey) {
      const items: Array<{ effect: ExternalEffect; send: () => Promise<void> }> = recipients.map(
        (userId) => ({
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
        }),
      );
      await this.effects.executeBatch(items);
      return;
    }

    const delivered = await boundedMap(recipients, PUBLISH_CONCURRENCY, (userId) =>
      this.ably.publishToUser(orgId, userId, "notification:mention", {
        channelId,
        messageId: message.id,
        senderId: message.senderUserId ?? "",
        senderName: message.senderName,
      }),
    );
    reportFailures("notification:mention", channelId, delivered);
  }
}
