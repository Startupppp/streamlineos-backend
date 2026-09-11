import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { listSchema, type ListInput } from "./dto/notification.schemas";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import type { Principal } from "../../common/auth/principal";
import { queryNotifications, queryUnreadCount } from "./lib/notification-queries";
import { attachTicketContext } from "./lib/notification-ticket-context";

@Injectable()
export class NotificationsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly visibility: NotificationVisibilityRegistry,
  ) {}

  /**
   * Derived from `listSchema` itself rather than written out, because the
   * hand-written key omitted `sourceModule` — an accepted, `.strict()`-validated
   * query parameter and a real predicate at `queryNotifications`. So
   * `?sourceModule=hr` and `?sourceModule=chat` hashed to the same key and, within
   * CACHE_TTL.SHORT, the second caller was served the first one's filtered page.
   * Scoped to one user+org, so not a tenant leak — silently wrong data.
   *
   * `check:namespace-coverage` cannot see this class of bug: it verifies that
   * namespaces are bumped, never that the inner key enumerates every filter
   * dimension. Enumerating the schema is what makes the next added filter safe by
   * construction instead of by whoever remembers this comment.
   */
  private listCacheKey(filters: ListInput, section: string, limit: number): string {
    const resolved: Record<string, unknown> = { ...filters, section, limit };
    const parts = Object.keys(listSchema.shape)
      .sort()
      .map((field) => [field, resolved[field] ?? null]);
    return `list:${JSON.stringify(parts)}`;
  }

  /**
   * The page is cached; the ticket context is not. Which tickets a reader may
   * see is decided per principal by the visibility registry, so it is attached
   * after the cache and never stored in it.
   */
  async list(orgId: string, userId: string, filters: ListInput, principal?: Principal) {
    const limit = Math.min(filters.limit ?? 20, 100);
    const section = filters.unreadOnly ? "UNREAD" : (filters.section ?? "ALL");
    const key = `history-v2:${this.listCacheKey(filters, section, limit)}`;
    const page = await this.cache.cachedVersioned(
      `notifications:${userId}:${orgId}`,
      key,
      () =>
        queryNotifications(this.db, orgId, userId, { ...filters, limit, section }),
      CACHE_TTL.SHORT,
    );
    return {
      ...page,
      data: await attachTicketContext(this.visibility, orgId, userId, page.data, principal),
    };
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
