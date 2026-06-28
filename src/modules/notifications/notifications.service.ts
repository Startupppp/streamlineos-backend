import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, sql } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListInput } from "./dto/notification.schemas";

export interface CreateNotificationInput {
  orgId: string;
  userId: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async create(input: CreateNotificationInput) {
    const [notification] = await this.db
      .insert(notifications)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        type: input.type ?? "INFO",
        title: input.title,
        message: input.message,
        link: input.link,
        metadata: input.metadata,
      })
      .returning();

    return notification;
  }

  list(orgId: string, userId: string, filters: ListInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const key = `notifications:list:${userId}:${orgId}:${filters.unreadOnly ? "unread" : "all"}:${limit}`;
    return this.cache.cached(
      key,
      () => this.queryNotifications(orgId, userId, { ...filters, limit }),
      CACHE_TTL.SHORT,
    );
  }

  private queryNotifications(orgId: string, userId: string, filters: ListInput) {
    const conditions = [
      eq(notifications.orgId, orgId),
      eq(notifications.userId, userId),
    ];
    if (filters.unreadOnly) {
      conditions.push(eq(notifications.isRead, false));
    }

    return this.db.query.notifications.findMany({
      where: and(...conditions),
      orderBy: [desc(notifications.createdAt)],
      limit: filters.limit,
    });
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
        ),
      );
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
        ),
      );
    return { success: true };
  }

  async clearAll(orgId: string, userId: string) {
    await this.db
      .delete(notifications)
      .where(
        and(eq(notifications.orgId, orgId), eq(notifications.userId, userId)),
      );
    return { success: true };
  }
}
