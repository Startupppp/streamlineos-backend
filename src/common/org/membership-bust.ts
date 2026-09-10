import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../auth/membership-state.service";
import { registerAfterCommit } from "../tenant/tenant-context";
import type { CacheService } from "../cache/cache.service";

/**
 * Schedule a membership status cache bust to fire after the current request
 * transaction commits. When called outside an ambient tenant context (cron
 * workers, background tasks) it falls back to running inline so the work is
 * never dropped.
 *
 * This is the only call site for membership cache invalidation that new writers
 * should use. Calling `bustMembershipStatusCache` directly skips the
 * after-commit coupling and may run a bust against a transaction that later
 * rolls back, or hold stale membership data in the cache for up to 15 seconds
 * when a crash interrupts an inline call before the transaction commits.
 */
export async function scheduleMembershipBust(
  cache: CacheService,
  userId: string,
  orgId?: string,
): Promise<void> {
  const work = (): Promise<void> =>
    orgId === undefined
      ? bustMembershipStatusCache(cache, userId)
      : bustMembershipStatusCache(cache, userId, orgId);
  if (!registerAfterCommit(work)) await work();
}

/**
 * Revocation only: bust NOW and again after the transaction commits.
 *
 * The double is deliberate and `membership-revocation.spec.ts` pins it. The
 * immediate bust closes the window in which a concurrent request re-populates
 * the cache with pre-revocation data while the revoking transaction is still
 * open; the after-commit bust clears whatever landed during it. Dropping either
 * half leaves a revoked member reading as active for up to the 15s TTL.
 *
 * `run` carries the caller's other invalidations so both passes clear the same
 * set — the userSession key has to move on both passes too, not just the first.
 */
export async function bustMembershipNowAndAfterCommit(
  run: () => Promise<void>,
): Promise<void> {
  await run();
  registerAfterCommit(run);
}

/**
 * Batch variant of `scheduleMembershipBust` for operations that touch many
 * members at once. Issues two Redis commands total regardless of list length
 * instead of two per user.
 */
export async function scheduleMembershipBustMany(
  cache: CacheService,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const work = (): Promise<void> => bustMembershipStatusCacheMany(cache, userIds);
  if (!registerAfterCommit(work)) await work();
}
