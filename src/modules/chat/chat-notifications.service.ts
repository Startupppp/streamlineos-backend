import { Inject, Injectable } from "@nestjs/common";
import { chatChannelMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { and, eq, inArray } from "drizzle-orm";

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

@Injectable()
export class ChatNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly orgSettings: ChatOrgSettingsService,
  ) {}

  async publishNewMessageNotification(
    orgId: string,
    channelId: number,
    message: { id: number; senderId: string; senderName: string | null },
    channelType: string,
  ) {
    const members = await this.db
      .select({
        userId: chatChannelMembers.userId,
        mutedUntil: chatChannelMembers.mutedUntil,
        notificationPreference: chatChannelMembers.notificationPreference,
      })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const now = new Date();
    const recipients = members.filter(({ userId, mutedUntil, notificationPreference }) => {
      if (userId === message.senderId) return false;
      if (mutedUntil && mutedUntil > now) return false;
      const effectivePreference =
        notificationPreference !== "DEFAULT" ? notificationPreference : defaultPreference;
      return !SUPPRESSED_GENERAL_PREFERENCES.has(effectivePreference);
    });

    await Promise.allSettled(
      recipients.map(({ userId }) =>
        this.ably.publishToUser(orgId, userId, "notification:message", {
          channelId,
          messageId: message.id,
          senderId: message.senderId,
          senderName: message.senderName,
          channelType,
        }),
      ),
    );
  }

  async publishMentionNotification(
    orgId: string,
    channelId: number,
    message: { id: number; senderId: string; senderName: string },
    mentionedUserIds: string[],
  ) {
    if (mentionedUserIds.length === 0) return;

    const members = await this.db
      .select({
        userId: chatChannelMembers.userId,
        notificationPreference: chatChannelMembers.notificationPreference,
      })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.channelId, channelId),
          inArray(chatChannelMembers.userId, mentionedUserIds),
        ),
      );
    const preferenceByUser = new Map(members.map((m) => [m.userId, m.notificationPreference]));

    const settings = await this.orgSettings.getSettings(orgId);
    const defaultPreference = settings.defaultNotificationPreference;

    const recipients = mentionedUserIds.filter((userId) => {
      const pref = preferenceByUser.get(userId) ?? "DEFAULT";
      return (pref !== "DEFAULT" ? pref : defaultPreference) !== "NOTHING";
    });

    await Promise.allSettled(
      recipients.map((userId) =>
        this.ably.publishToUser(orgId, userId, "notification:mention", {
          channelId,
          messageId: message.id,
          senderId: message.senderId,
          senderName: message.senderName,
        }),
      ),
    );
  }
}
