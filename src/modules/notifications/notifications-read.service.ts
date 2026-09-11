import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListInput } from "./dto/notification.schemas";
import { queryNotifications, queryUnreadCount } from "./lib/notification-queries";

@Injectable()
export class NotificationsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string, userId: string, filters: ListInput) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const section = filters.unreadOnly ? "UNREAD" : (filters.section ?? "ALL");
    const key = `list:${section}:${filters.category ?? ""}:${filters.priority ?? ""}:${limit}:${filters.cursor ?? ""}:${filters.search ?? ""}`;
    return this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      key,
      () =>
        queryNotifications(this.db, orgId, userId, { ...filters, limit, section }),
      CACHE_TTL.SHORT,
    );
  }

  unreadCount(orgId: string, userId: string) {
    return this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      "unread-count",
      () => queryUnreadCount(this.db, orgId, userId),
      CACHE_TTL.SHORT,
    );
  }

}
