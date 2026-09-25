import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../auth/membership-state.service";
import { registerAfterCommit } from "../tenant/tenant-context";
import { CACHE_KEYS } from "../cache/cache-keys";
import type { CacheService } from "../cache/cache.service";

// Primitives here are private to membership-mutations.ts; check:membership-writes enforces it.

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

export async function bustMembershipNowAndAfterCommit(
  run: () => Promise<void>,
): Promise<void> {
  await run();
  registerAfterCommit(run);
}

export async function scheduleMembershipBustMany(
  cache: CacheService,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const work = (): Promise<void> => bustMembershipStatusCacheMany(cache, userIds);
  if (!registerAfterCommit(work)) await work();
}

// Revocation busts now AND after commit; membership-revocation.spec.ts pins both passes.
export function revokeMembershipAccessCaches(
  cache: CacheService,
  orgId: string,
  userId: string,
): Promise<void> {
  return bustMembershipNowAndAfterCommit(() =>
    Promise.all([
      cache.invalidate(CACHE_KEYS.userSession(userId)),
      bustMembershipStatusCache(cache, userId, orgId),
    ]).then(() => undefined),
  );
}

// Module ownership moves resolved permissions without touching the membership row.
export async function bustMembershipAfterOwnershipChange(
  cache: CacheService,
  orgId: string,
  userId: string,
): Promise<void> {
  await cache.invalidate(CACHE_KEYS.userSession(userId));
  await scheduleMembershipBust(cache, userId, orgId);
}
