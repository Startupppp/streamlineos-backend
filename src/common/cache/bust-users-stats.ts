import { CACHE_KEYS } from "./cache-keys";
import type { CacheService } from "./cache.service";

export function bustUsersStatsCache(cache: CacheService, orgId: string): Promise<void> {
  return cache.invalidate(CACHE_KEYS.usersStats(orgId));
}
