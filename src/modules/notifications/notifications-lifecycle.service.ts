import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, isNull, inArray, max } from "drizzle-orm";
import { notifications, notificationReadWatermarks, organizationMembers } from "../../db/schema";
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

  private async resolveMembershipId(orgId: string, userId: string): Promise<number> {
    const [member] = await this.db.select({ id: organizationMembers.id }).from(organizationMembers).where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
    ).limit(1);
    if (!member) throw new NotFoundException("Organization membership required");
    return member.id;
  }

  async approve(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
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
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async reject(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
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
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async markRead(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async markAllRead(orgId: string, userId: string) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const [latest] = await this.db
      .select({ maxId: max(notifications.id) })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.membershipId, membershipId),
          isNull(notifications.deletedAt),
        ),
      );
    const maxId = latest?.maxId != null ? Number(latest.maxId) : null;
    if (maxId != null && maxId > 0) {
      await this.db
        .insert(notificationReadWatermarks)
        .values({ orgId, userId, membershipId, lastReadNotificationId: maxId })
        .onConflictDoUpdate({
          target: [notificationReadWatermarks.orgId, notificationReadWatermarks.membershipId],
          set: { lastReadNotificationId: maxId, updatedAt: new Date() },
        });
    }
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async archive(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async unarchive(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ archivedAt: null })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async softDelete(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async pin(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ pinned: true })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async unpin(orgId: string, userId: string, notificationId: number) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ pinned: false })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async snooze(
    orgId: string,
    userId: string,
    notificationId: number,
    input: SnoozeInput,
  ) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const rows = await this.db
      .update(notifications)
      .set({ snoozedUntil: new Date(input.snoozedUntil) })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) throw new NotFoundException();
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  /**
   * A mixed-tenant id list must fail the whole request. Narrowing the update to
   * the rows the caller owns and returning `{ success: true }` tells the caller
   * every id was acted on and turns the response into an existence oracle. The
   * single-id paths above already do this with `.returning()`; the property was
   * lost at the bulk boundary.
   */
  private async assertOwnsAll(
    orgId: string,
    membershipId: number,
    ids: readonly number[],
  ): Promise<number[]> {
    const requestedIds = [...new Set(ids)];
    const owned = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          inArray(notifications.id, requestedIds),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
        ),
      )
      .limit(requestedIds.length);
    if (owned.length !== requestedIds.length)
      throw new NotFoundException("One or more notification IDs not found for this recipient");
    return requestedIds;
  }

  async bulkMarkRead(orgId: string, userId: string, input: BulkActionInput) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const requestedIds = await this.assertOwnsAll(orgId, membershipId, input.ids);
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          inArray(notifications.id, requestedIds),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async bulkArchive(orgId: string, userId: string, input: BulkActionInput) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const requestedIds = await this.assertOwnsAll(orgId, membershipId, input.ids);
    await this.db
      .update(notifications)
      .set({ archivedAt: new Date() })
      .where(
        and(
          inArray(notifications.id, requestedIds),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async bulkDelete(orgId: string, userId: string, input: BulkActionInput) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    const requestedIds = await this.assertOwnsAll(orgId, membershipId, input.ids);
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(notifications.id, requestedIds),
          eq(notifications.membershipId, membershipId),
          eq(notifications.orgId, orgId),
        ),
      );
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async clearAll(orgId: string, userId: string) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.membershipId, membershipId),
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
