import { bustMembershipStatusCache } from "../auth/membership-state.service";
import { registerAfterCommit } from "../tenant/tenant-context";
import { CACHE_KEYS } from "../cache/cache-keys";
import type { CacheService } from "../cache/cache.service";
import { scheduleStandingRevocation } from "../rbac/access-mutation-commit";

// Primitives here are private to membership-mutations.ts; check:membership-writes enforces it.

async function bustMembershipNowAndAfterCommit(
  run: () => Promise<void>,
): Promise<void> {
  await run();
  registerAfterCommit(run);
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

export function bustMembershipsAfterOrgTeardown(
  cache: CacheService,
  userIds: readonly string[],
): Promise<void> {
  return scheduleStandingRevocation(cache, userIds);
}

export function bustMembershipAfterIdentityErasure(
  cache: CacheService,
  userId: string,
): Promise<void> {
  return scheduleStandingRevocation(cache, [userId]);
}
