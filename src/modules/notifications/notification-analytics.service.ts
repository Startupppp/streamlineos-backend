import { Inject, Injectable } from "@nestjs/common";
import { eq, and, gte, sql, isNull } from "drizzle-orm";
import { notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

@Injectable()
export class NotificationAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getOverview(orgId: string, days = 30) {
    const key = `notification-analytics:overview:${orgId}:${days}`;
    return this.cache.cached(key, () => this.queryOverview(orgId, days), CACHE_TTL.MEDIUM);
  }

  private async queryOverview(orgId: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [result] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        read: sql<number>`count(*) filter (where ${notifications.isRead} = true)::int`,
        archived: sql<number>`count(*) filter (where ${notifications.archivedAt} is not null)::int`,
        active: sql<number>`count(*) filter (where ${notifications.deletedAt} is null and ${notifications.archivedAt} is null)::int`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          gte(notifications.createdAt, since),
          isNull(notifications.deletedAt),
        ),
      );

    const total = Number(result?.total ?? 0);
    const read = Number(result?.read ?? 0);
    const archived = Number(result?.archived ?? 0);
    const readRate = total > 0 ? Math.round((read / total) * 100) : 0;

    return { total, read, archived, readRate, days };
  }

  getByCategory(orgId: string, days = 30) {
    const key = `notification-analytics:by-category:${orgId}:${days}`;
    return this.cache.cached(key, () => this.queryByCategory(orgId, days), CACHE_TTL.MEDIUM);
  }

  private async queryByCategory(orgId: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.db
      .select({
        category: notifications.category,
        total: sql<number>`count(*)::int`,
        read: sql<number>`count(*) filter (where ${notifications.isRead} = true)::int`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          gte(notifications.createdAt, since),
          isNull(notifications.deletedAt),
        ),
      )
      .groupBy(notifications.category)
      .orderBy(sql`count(*) desc`);

    return rows.map((r) => ({
      category: r.category,
      total: Number(r.total),
      read: Number(r.read),
      readRate: Number(r.total) > 0 ? Math.round((Number(r.read) / Number(r.total)) * 100) : 0,
    }));
  }

  getByPriority(orgId: string, days = 30) {
    const key = `notification-analytics:by-priority:${orgId}:${days}`;
    return this.cache.cached(key, () => this.queryByPriority(orgId, days), CACHE_TTL.MEDIUM);
  }

  private async queryByPriority(orgId: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.db
      .select({
        priority: notifications.priority,
        total: sql<number>`count(*)::int`,
        read: sql<number>`count(*) filter (where ${notifications.isRead} = true)::int`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          gte(notifications.createdAt, since),
          isNull(notifications.deletedAt),
        ),
      )
      .groupBy(notifications.priority)
      .orderBy(sql`count(*) desc`);

    return rows.map((r) => ({
      priority: r.priority,
      total: Number(r.total),
      read: Number(r.read),
      readRate: Number(r.total) > 0 ? Math.round((Number(r.read) / Number(r.total)) * 100) : 0,
    }));
  }
}
