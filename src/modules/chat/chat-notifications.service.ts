import { Inject, Injectable } from "@nestjs/common";
import { chatChannelMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { and, eq, inArray } from "drizzle-orm";

const SUPPRESSED_GENERAL_PREFERENCES = new Set(["NOTHING", "MENTIONS"]);

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
    message: { id: number; content: string | null; senderId: string; senderName: string | null },
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
    for (const { userId, mutedUntil, notificationPreference } of members) {
      if (userId === message.senderId) continue;
      if (mutedUntil && mutedUntil > now) continue;
      const effectivePreference =
        notificationPreference !== "DEFAULT" ? notificationPreference : defaultPreference;
      if (SUPPRESSED_GENERAL_PREFERENCES.has(effectivePreference)) continue;
      await this.ably.publishToUser(orgId, userId, "notification:message", {
        channelId,
        messageId: message.id,
        content: message.content,
        senderId: message.senderId,
        senderName: message.senderName,
        channelType,
      });
    }
  }

  async publishMentionNotification(
    orgId: string,
    channelId: number,
    message: { id: number; content: string; senderId: string; senderName: string },
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

    for (const userId of mentionedUserIds) {
      const pref = preferenceByUser.get(userId) ?? "DEFAULT";
      const effectivePreference = pref !== "DEFAULT" ? pref : defaultPreference;
      if (effectivePreference === "NOTHING") continue;
      await this.ably.publishToUser(orgId, userId, "notification:mention", {
        channelId,
        messageId: message.id,
        content: message.content,
        senderId: message.senderId,
        senderName: message.senderName,
      });
    }
  }
}
