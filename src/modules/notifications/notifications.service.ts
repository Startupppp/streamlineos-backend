import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, sql, isNull, isNotNull, inArray, lt, gte, lte, ilike, or } from "drizzle-orm";
import { notifications, notificationAuditLogs, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListInput, SnoozeInput, BulkActionInput, AuditLogsInput } from "./dto/notification.schemas";
import { NotificationEventService } from "./notification-event.service";

export type NotificationCategoryValue =
  | "SECURITY" | "CRM" | "HRMS" | "BILLING" | "AI" | "PROJECTS" | "WORKFLOW" | "MARKETING" | "SYSTEM"
  | "CHAT" | "PAYROLL" | "RECRUITMENT" | "KNOWLEDGE" | "SIGN" | "INVENTORY" | "SURVEYS" | "CALENDAR" | "SUPPORT";

export interface CreateNotificationInput {
  orgId: string;
  userId: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  category?: NotificationCategoryValue;
  sourceModule?: string;
  eventKey?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string | null;
  groupKey?: string;
  reason?: string;
  title: string;
  message: string;
  link?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly notifEvents: NotificationEventService,
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
        groupKey: input.groupKey,
        reason: input.reason,
        title: input.title,
        message: input.message,
        link: input.link,
        channel: input.channel ?? "IN_APP",
        metadata: input.metadata,
      })
      .returning();

    await this.audit(input.orgId, input.actorUserId ?? null, "notification.created", notification?.id, input.eventKey ? { eventKey: input.eventKey } : undefined);
    await this.notifyChanged(input.userId, input.orgId);
    return notification;
  }

  async notifyChanged(userId: string, orgId: string): Promise<void> {
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
  }

  list(orgId: string, userId: string, filters: ListInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const section = filters.unreadOnly ? "UNREAD" : (filters.section ?? "ALL");
    const key = `notifications:list:${userId}:${orgId}:${section}:${filters.category ?? ""}:${filters.priority ?? ""}:${limit}:${filters.cursor ?? ""}:${filters.search ?? ""}`;
    return this.cache.cached(
      key,
      () => this.queryNotifications(orgId, userId, { ...filters, limit, section }),
      CACHE_TTL.SHORT,
    );
  }

  private queryNotifications(orgId: string, userId: string, filters: ListInput & { section: string }) {
    const conditions = [
      eq(notifications.orgId, orgId),
      eq(notifications.userId, userId),
      isNull(notifications.deletedAt),
    ];

    switch (filters.section) {
      case "UNREAD":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.isRead, false));
        break;
      case "READ":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.isRead, true));
        break;
      case "ARCHIVED":
        conditions.push(isNotNull(notifications.archivedAt));
        break;
      case "SYSTEM":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.category, "SYSTEM"));
        break;
      case "PINNED":
        conditions.push(eq(notifications.pinned, true));
        break;
      case "APPROVALS":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.category, "WORKFLOW"));
        break;
      case "BROADCASTS":
        conditions.push(isNull(notifications.archivedAt));
        conditions.push(eq(notifications.sourceModule, "broadcast"));
        break;
      default:
        conditions.push(isNull(notifications.archivedAt));
        break;
    }

    if (filters.category && filters.section !== "SYSTEM" && filters.section !== "APPROVALS") {
      conditions.push(eq(notifications.category, filters.category));
    }
    if (filters.priority) {
      conditions.push(eq(notifications.priority, filters.priority));
    }
    if (filters.sourceModule) {
      conditions.push(eq(notifications.sourceModule, filters.sourceModule));
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      const searchCondition = or(ilike(notifications.title, term), ilike(notifications.message, term));
      if (searchCondition) conditions.push(searchCondition);
    }
    if (filters.cursor) {
      conditions.push(lt(notifications.id, filters.cursor));
    }

    return this.db.query.notifications.findMany({
      where: and(...conditions),
      orderBy: [desc(notifications.createdAt)],
      limit: filters.limit,
    });
  }

  async approve(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ isRead: true, metadata: { approved: true, approvedAt: new Date().toISOString(), approvedBy: userId } })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.audit(orgId, userId, "notification.approved", notificationId);
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async reject(orgId: string, userId: string, notificationId: number) {
    await this.db
      .update(notifications)
      .set({ isRead: true, metadata: { rejected: true, rejectedAt: new Date().toISOString(), rejectedBy: userId } })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          eq(notifications.orgId, orgId),
          isNull(notifications.deletedAt),
        ),
      );
    await this.audit(orgId, userId, "notification.rejected", notificationId);
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  unreadCount(orgId: string, userId: string) {
    const key = `notifications:unread-count:${userId}:${orgId}`;
    return this.cache.cached(
      key,
      () => this.queryUnreadCount(orgId, userId),
      CACHE_TTL.SHORT,
    );
  }

  private async queryUnreadCount(orgId: string, userId: string) {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          isNull(notifications.deletedAt),
          isNull(notifications.archivedAt),
        ),
      );
    return { count: Number(result?.count ?? 0) };
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
    await this.audit(orgId, userId, "notification.read", notificationId);
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
    await this.audit(orgId, userId, "notification.all_read");
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
    await this.audit(orgId, userId, "notification.archived", notificationId);
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
    await this.audit(orgId, userId, "notification.unarchived", notificationId);
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
    await this.audit(orgId, userId, "notification.deleted", notificationId);
    await this.invalidateCache(userId, orgId);
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
    await this.audit(orgId, userId, "notification.pinned", notificationId);
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
    await this.audit(orgId, userId, "notification.unpinned", notificationId);
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async snooze(orgId: string, userId: string, notificationId: number, input: SnoozeInput) {
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
    await this.audit(orgId, userId, "notification.snoozed", notificationId, { snoozedUntil: input.snoozedUntil });
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
    await this.audit(orgId, userId, "notification.bulk_read", undefined, { ids: input.ids });
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
    await this.audit(orgId, userId, "notification.bulk_archived", undefined, { ids: input.ids });
    await this.invalidateCache(userId, orgId);
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
    await this.audit(orgId, userId, "notification.bulk_deleted", undefined, { ids: input.ids });
    await this.invalidateCache(userId, orgId);
    return { success: true };
  }

  async clearAll(orgId: string, userId: string) {
    await this.db
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), isNull(notifications.deletedAt)),
      );
    await this.audit(orgId, userId, "notification.clear_all");
    await this.invalidateCache(userId, orgId);
    this.notifEvents.emit({ userId, orgId, type: "count_changed" });
    return { success: true };
  }

  async listAuditLogs(orgId: string, filters: AuditLogsInput) {
    const { page, pageSize, action, dateFrom, dateTo } = filters;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(notificationAuditLogs.orgId, orgId)];
    if (action) conditions.push(eq(notificationAuditLogs.action, action));
    if (dateFrom) conditions.push(gte(notificationAuditLogs.createdAt, new Date(dateFrom)));
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(notificationAuditLogs.createdAt, end));
    }

    const where = and(...conditions);

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: notificationAuditLogs.id,
          notificationId: notificationAuditLogs.notificationId,
          broadcastId: notificationAuditLogs.broadcastId,
          actorId: notificationAuditLogs.actorId,
          actorName: users.name,
          actorEmail: users.email,
          action: notificationAuditLogs.action,
          sourceModule: notificationAuditLogs.sourceModule,
          channel: notificationAuditLogs.channel,
          metadata: notificationAuditLogs.metadata,
          createdAt: notificationAuditLogs.createdAt,
        })
        .from(notificationAuditLogs)
        .leftJoin(users, eq(notificationAuditLogs.actorId, users.id))
        .where(where)
        .orderBy(desc(notificationAuditLogs.createdAt))
        .limit(pageSize)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notificationAuditLogs)
        .where(where),
    ]);

    return {
      logs: rows,
      total: count,
      page,
      totalPages: Math.ceil(count / pageSize),
    };
  }

  private async audit(
    orgId: string,
    actorId: string | null,
    action: string,
    notificationId?: number,
    metadata?: Record<string, unknown>,
  ) {
    await this.db.insert(notificationAuditLogs).values({
      orgId,
      actorId,
      action,
      notificationId: notificationId ?? null,
      metadata: metadata ?? null,
    });
  }

  private async invalidateCache(userId: string, orgId: string) {
    await Promise.all([
      this.cache.invalidatePattern(`notifications:list:${userId}:${orgId}:*`),
      this.cache.del(`notifications:unread-count:${userId}:${orgId}`),
    ]);
  }
}
