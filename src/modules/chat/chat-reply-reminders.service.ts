import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
  chatReplyReminders,
  notificationPreferences,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant/for-each-org";
import { getChatReplyReminderEmail } from "../email/templates/chat";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { logger } from "../../common/logger/logger.service";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";

const REMINDER_INSERT_BATCH_SIZE = 500;

@Injectable()
export class ChatReplyRemindersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.replyReminderMs = (config.CHAT_REPLY_REMINDER_MINUTES ?? 15) * 60 * 1000;
  }

  private readonly replyReminderMs: number;

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  async scheduleForMessage(
    orgId: string,
    channelId: number,
    messageId: number,
    senderId: string,
  ): Promise<void> {
    const remindAt = new Date(Date.now() + this.replyReminderMs);

    await this.cancelPendingForRecipientInChannel(senderId, channelId);

    const senderMembershipId = await this.resolveMembershipId(orgId, senderId);

    const members = await this.db.query.chatChannelMembers.findMany({
      where: and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.channelId, channelId)),
      columns: { membershipId: true },
      with: {
        membership: {
          columns: { userId: true },
        },
      },
    });

    const reminders = members
      .filter((member) => member.membership?.userId !== undefined && member.membership.userId !== senderId)
      .map((member) => ({
        orgId,
        channelId,
        messageId,
        recipientUserId: member.membership!.userId,
        recipientMembershipId: member.membershipId,
        senderUserId: senderId,
        senderMembershipId,
        remindAt,
      }));

    for (let offset = 0; offset < reminders.length; offset += REMINDER_INSERT_BATCH_SIZE) {
      await this.db
        .insert(chatReplyReminders)
        .values(reminders.slice(offset, offset + REMINDER_INSERT_BATCH_SIZE))
        .onConflictDoNothing();
    }
  }

  async cancelPendingForRecipientInChannel(userId: string, channelId: number): Promise<void> {
    await this.db
      .update(chatReplyReminders)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(chatReplyReminders.recipientUserId, userId),
          eq(chatReplyReminders.channelId, channelId),
          isNull(chatReplyReminders.sentAt),
          isNull(chatReplyReminders.cancelledAt),
        ),
      );
  }

  async processDueReminders(): Promise<{ sent: number; cancelled: number }> {
    const now = new Date();
    let sent = 0;
    let cancelled = 0;

    await forEachOrg(this.db, "chat-reply-reminders", async (_tx, orgId) => {
      const due = await this.db.query.chatReplyReminders.findMany({
        where: and(
          eq(chatReplyReminders.orgId, orgId),
          lte(chatReplyReminders.remindAt, now),
          isNull(chatReplyReminders.sentAt),
          isNull(chatReplyReminders.cancelledAt),
        ),
        limit: 100,
      });

      for (const reminder of due) {
        try {
          const handled = await this.processReminder(reminder.id);
          if (handled === "sent") sent += 1;
          if (handled === "cancelled") cancelled += 1;
        } catch (error) {
          logger.error("[chat.processReplyReminder]", {
            reminderId: reminder.id,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    });

    return { sent, cancelled };
  }

  private async processReminder(
    reminderId: number,
  ): Promise<"sent" | "cancelled" | "skipped"> {
    const reminder = await this.db.query.chatReplyReminders.findFirst({
      where: eq(chatReplyReminders.id, reminderId),
    });
    if (!reminder || reminder.sentAt || reminder.cancelledAt) return "skipped";

    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, reminder.messageId), eq(chatMessages.isDeleted, false)),
      columns: { id: true, content: true, createdAt: true, channelId: true },
    });
    if (!message) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const reply = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.channelId, reminder.channelId),
        eq(chatMessages.senderId, reminder.recipientUserId),
        eq(chatMessages.isDeleted, false),
        gt(chatMessages.createdAt, message.createdAt),
      ),
      columns: { id: true },
    });
    if (reply) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, reminder.channelId),
        eq(chatChannelMembers.userId, reminder.recipientUserId),
      ),
      columns: { mutedUntil: true, archivedAt: true },
    });
    if (!membership) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }
    if (membership.archivedAt) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }
    if (membership.mutedUntil && new Date(membership.mutedUntil) > new Date()) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const recipient = await this.db.query.users.findFirst({
      where: eq(users.id, reminder.recipientUserId),
      columns: { id: true, name: true, email: true, isActive: true },
    });
    const sender = await this.db.query.users.findFirst({
      where: eq(users.id, reminder.senderUserId),
      columns: { name: true },
    });
    if (!recipient?.email || !recipient.isActive) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const prefs = await this.db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, reminder.recipientUserId),
      columns: { emailEnabled: true },
    });
    if (prefs && !prefs.emailEnabled) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, reminder.channelId),
      columns: { name: true, type: true },
    });
    if (!channel) {
      await this.markCancelled(reminderId);
      return "cancelled";
    }

    const channelLabel =
      channel.type === "DIRECT"
        ? sender?.name ?? "Direct message"
        : channel.name;

    await this.dispatch.emit({
      eventKey: "chat.reply.reminder",
      orgId: reminder.orgId,
      targetUserIds: [recipient.id],
      entityType: "chat_message",
      entityId: String(message.id),
      title: `${sender?.name ?? "Someone"} messaged you on StreamlineOS`,
      message: `${sender?.name ?? "Someone"} sent you a message in ${channelLabel}.`,
      emailHtml: getChatReplyReminderEmail(
        recipient.name ?? "there",
        sender?.name ?? "Someone",
        message.content ?? "",
        channelLabel,
        reminder.channelId,
      ),
    });

    await this.db
      .update(chatReplyReminders)
      .set({ sentAt: new Date() })
      .where(eq(chatReplyReminders.id, reminderId));

    return "sent";
  }

  private async markCancelled(reminderId: number): Promise<void> {
    await this.db
      .update(chatReplyReminders)
      .set({ cancelledAt: new Date() })
      .where(eq(chatReplyReminders.id, reminderId));
  }
}
