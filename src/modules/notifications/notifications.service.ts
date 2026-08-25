import { Inject, Injectable } from "@nestjs/common";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  ListInput,
  SnoozeInput,
  BulkActionInput,
} from "./dto/notification.schemas";
import { NotificationEventService } from "./notification-event.service";
import { WebPushService } from "../realtime/web-push.service";
import { NotificationsReadService } from "./notifications-read.service";
import { logger } from "../../common/logger/logger.service";
import { NotificationsLifecycleService } from "./notifications-lifecycle.service";
import { isNotificationCategory } from "./notifications.types";
import type {
  AnnounceInput,
  CreateNotificationInput,
  NotificationCategoryValue,
} from "./notifications.types";

export type {
  AnnounceInput,
  CreateNotificationInput,
  NotificationCategoryValue,
};

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifEvents: NotificationEventService,
    private readonly webPush: WebPushService,
    private readonly read: NotificationsReadService,
    private readonly lifecycle: NotificationsLifecycleService,
  ) {}

  async create(input: CreateNotificationInput) {
    const [notification] = await this.db
      .insert(notifications)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        type: input.type ?? "INFO",
        priority: input.priority ?? "NORMAL",
        category: input.category ?? "SYSTEM",
        sourceModule: input.sourceModule,
        eventKey: input.eventKey,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId ?? null,
        reason: input.reason,
        title: input.title,
        message: input.message,
        link: input.link,
        channel: input.channel ?? "IN_APP",
        metadata: input.metadata,
      })
      .returning({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        priority: notifications.priority,
        category: notifications.category,
        link: notifications.link,
        sourceModule: notifications.sourceModule,
        eventKey: notifications.eventKey,
      });

    if (notification) {
      await this.announce({
        id: notification.id,
        userId: input.userId,
        orgId: input.orgId,
        title: notification.title,
        message: notification.message,
        priority: notification.priority,
        category: notification.category,
        link: notification.link,
        sourceModule: notification.sourceModule,
        eventKey: notification.eventKey,
      });
    }
    return notification;
  }

  async notifyChanged(userId: string, orgId: string): Promise<void> {
    await this.lifecycle.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
  }

  async announce(input: AnnounceInput, pushToDevices = true): Promise<void> {
    await this.lifecycle.invalidateCache(input.userId, input.orgId);
    this.notifEvents.emit({
      userId: input.userId,
      orgId: input.orgId,
      type: "notification",
      notification: {
        id: input.id,
        title: input.title,
        message: input.message,
        priority: input.priority,
        category: input.category,
        link: input.link,
        eventKey: input.eventKey,
      },
    });
    if (pushToDevices) this.pushToDevice(input);
  }

  private pushToDevice(input: AnnounceInput): void {
    if (input.priority === "LOW") return;
    if (input.sourceModule === "chat") return;
    // RT-001: id + category only. The title and message stay server-side; the
    // client fetches them through the authenticated API.
    void this.webPush
      .sendToUser(input.userId, {
        notificationId: input.id,
        category: isNotificationCategory(input.category) ? input.category : undefined,
        url: input.link ?? "/notifications",
      })
      .catch((err: unknown) => {
        logger.warn("web push delivery failed", {
          userId: input.userId,
          notificationId: input.id,
          cause: err instanceof Error ? (err.cause ?? err.message) : String(err),
        });
      });
  }

  list(orgId: string, userId: string, filters: ListInput) {
    return this.read.list(orgId, userId, filters);
  }

  unreadCount(orgId: string, userId: string) {
    return this.read.unreadCount(orgId, userId);
  }

  approve(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.approve(orgId, userId, notificationId);
  }

  reject(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.reject(orgId, userId, notificationId);
  }

  markRead(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.markRead(orgId, userId, notificationId);
  }

  markAllRead(orgId: string, userId: string) {
    return this.lifecycle.markAllRead(orgId, userId);
  }

  archive(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.archive(orgId, userId, notificationId);
  }

  unarchive(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.unarchive(orgId, userId, notificationId);
  }

  softDelete(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.softDelete(orgId, userId, notificationId);
  }

  pin(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.pin(orgId, userId, notificationId);
  }

  unpin(orgId: string, userId: string, notificationId: number) {
    return this.lifecycle.unpin(orgId, userId, notificationId);
  }

  snooze(
    orgId: string,
    userId: string,
    notificationId: number,
    input: SnoozeInput,
  ) {
    return this.lifecycle.snooze(orgId, userId, notificationId, input);
  }

  bulkMarkRead(orgId: string, userId: string, input: BulkActionInput) {
    return this.lifecycle.bulkMarkRead(orgId, userId, input);
  }

  bulkArchive(orgId: string, userId: string, input: BulkActionInput) {
    return this.lifecycle.bulkArchive(orgId, userId, input);
  }

  bulkDelete(orgId: string, userId: string, input: BulkActionInput) {
    return this.lifecycle.bulkDelete(orgId, userId, input);
  }

  clearAll(orgId: string, userId: string) {
    return this.lifecycle.clearAll(orgId, userId);
  }
}
