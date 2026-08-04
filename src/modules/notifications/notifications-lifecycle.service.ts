import { Inject, Injectable } from "@nestjs/common";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationEventService } from "./notification-event.service";
import type { SnoozeInput, BulkActionInput } from "./dto/notification.schemas";

@Injectable()
export class NotificationsLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly notifEvents: NotificationEventService,
  ) {}

  async approve(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({
        isRead: true,
        metadata: {
          approved: true,
          approvedAt: new Date().toISOString(),
          approvedBy: userId,
        },
      })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async reject(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({
        isRead: true,
        metadata: {
          rejected: true,
          rejectedAt: new Date().toISOString(),
          rejectedBy: userId,
        },
      })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async markRead(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async markAllRead(orgId: string, userId: string) {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async archive(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async unarchive(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ archivedAt: null })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async softDelete(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async pin(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ pinned: true })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async unpin(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ pinned: false })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async snooze(
    orgId: string,
    userId: string,
    notificationId: number,
    input: SnoozeInput,
  ) {
    await this.db
      .update(notifications)
      .set({ snoozedUntil: new Date(input.snoozedUntil) })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async bulkMarkRead(orgId: string, userId: string, input: BulkActionInput) {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          inArray(notifications.id, input.ids),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async bulkArchive(orgId: string, userId: string, input: BulkActionInput) {
    await this.db
      .update(notifications)
      .set({ archivedAt: new Date() })
      .where(
        and(
          inArray(notifications.id, input.ids),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async bulkDelete(orgId: string, userId: string, input: BulkActionInput) {
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(notifications.id, input.ids),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async clearAll(orgId: string, userId: string) {
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async invalidateCache(userId: string, orgId: string) {
    await this.cache.invalidateNamespace(`notifications:${userId}:${orgId}`);
  }
}
