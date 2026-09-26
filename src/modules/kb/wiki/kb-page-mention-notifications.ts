import type { Logger } from "@nestjs/common";
import type { NotificationsService } from "../../notifications/notifications.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";

export interface KbMentionNotificationTarget {
  orgId: string;
  userIds: string[];
  pageId: number;
  pageTitle: string;
  actorId: string;
}

export async function fireKbMentionNotifications(
  notifications: NotificationsService,
  logger: Logger,
  target: KbMentionNotificationTarget,
): Promise<void> {
  for (const userId of target.userIds) {
    if (userId === target.actorId) continue;
    try {
      await notifications.create({
        orgId: target.orgId,
        userId,
        type: "INFO",
        category: "SYSTEM",
        sourceModule: "kb",
        title: "You were mentioned in a page",
        message: `You were mentioned in "${target.pageTitle || "Untitled"}"`,
        link: `/knowledge/pages/${target.pageId}`,
      });
    } catch (err) {
      logger.error(`Mention notification failed for user ${userId}: ${err}`);
    }
  }
}

export async function deferKbMentionNotifications(
  notifications: NotificationsService,
  logger: Logger,
  target: KbMentionNotificationTarget,
): Promise<void> {
  const deferred = registerAfterCommit(async () => {
    await fireKbMentionNotifications(notifications, logger, target);
  });
  if (!deferred) {
    await fireKbMentionNotifications(notifications, logger, target).catch(
      (err: unknown) => {
        logger.error(`Failed to send mention notifications: ${String(err)}`);
      },
    );
  }
}
