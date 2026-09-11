import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import type { CacheService } from "../../../../common/cache/cache.service";

/**
 * Every cached read whose answer a stock movement changes, retired in one call.
 *
 * These six namespaces were four exact-key `invalidate()` calls duplicated
 * verbatim in `StockEngineService` and `StockEngineBatchService`, and not one of
 * them reached its reader:
 *
 *   - `inv:dashboard:<org>` was deleted; the reader stores
 *     `inv:dashboard:<org>:<scopeKey>`. `invalidate()` is `redis.del` of one
 *     exact key — there is no prefix delete — so the caller's own warehouse
 *     scope put the entry permanently out of the writer's reach.
 *   - `inv:reorder:<org>` was deleted; the reader stores
 *     `inv:reorder:paged:<org>:<scope>:<page>:<limit>`. Same defect, one segment
 *     deeper, and the invalidation matrix described it as reached "implicitly
 *     via the inv:reorder parent" — a parent delete Redis does not have.
 *   - `inv:stock:summary:<org>` and `inv:low-stock:<org>` were deleted and are
 *     written by nobody at all; the stock summary a user actually sees is
 *     `inv:stock:summary-report:<org>:<hash>`, which nothing invalidated.
 *   - `inv:ops:zones` and `inv:ops:summary`, the dark-store boards, are read
 *     through `cachedVersionedForOrg` and were bumped by nobody, so the zone
 *     board served pre-movement quantities for its whole TTL.
 *
 * A generation bump is scope-blind, which is the whole reason to prefer it: the
 * writer never has to know which discriminators the reader appended.
 *
 * Shared rather than copied because the two engine services had already drifted
 * apart once — the batch door is not a second implementation of the single door,
 * and a movement posted through either makes exactly the same reads stale.
 *
 * `allSettled`, not `all`: a Redis outage must not fail a movement that has
 * already committed. A missed bump costs one stale read until TTL; a throw here
 * would surface as a failed write whose rows are nonetheless in the ledger.
 */
export async function invalidateStockDerivedReads(
  cache: CacheService,
  orgId: string,
): Promise<void> {
  await Promise.allSettled([
    cache.invalidateNamespace(CACHE_KEYS.invDashboardNamespace(orgId)),
    cache.invalidateNamespace(CACHE_KEYS.invReorderNamespace(orgId)),
    cache.invalidateNamespace(CACHE_KEYS.invStockSummaryReportNamespace(orgId)),
    // The ops boards are the *ForOrg family, which resolves a region-scoped key
    // of its own — `invalidateNamespace` with the same literal would bump a
    // different counter and reach nothing.
    cache.invalidateNamespaceForOrg(orgId, "inv:ops:zones"),
    cache.invalidateNamespaceForOrg(orgId, "inv:ops:summary"),
  ]);
}
