import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers, roles } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
} from "../module-access.helpers";

/**
 * The spine the three flat-membership writes share.
 *
 * `addMember`, `updateMemberGroups` and `removeMember` all open with the same
 * two gates, all resolve the target's membership row, and all end by dropping
 * the same two cache keys. What they do NOT share is the interesting part, and
 * keeping only the common steps here is what makes the differences legible in
 * the service: the owner rule is "may this actor touch the owner's groups" for
 * add and update but a flat refusal for remove; the missing-member outcome is a
 * 400 for add, a 404 for update and a silent success for remove; and only
 * remove tolerates a member row that is no longer ACTIVE.
 *
 * Every function here takes the deps bag rather than reaching for a service, so
 * the DB call ORDER stays exactly as the service wrote it — the unit specs mock
 * `db.select` positionally and would pass or fail on a reordering.
 */
export interface FlatMemberWriteDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly access: AccessService;
}

/**
 * Gate one: the module must be one this surface manages at all, and the actor
 * must hold `manage` on it. Both writes and the remove path call this first,
 * before any row is read.
 */
export async function assertFlatMemberWriteAllowed(
  deps: FlatMemberWriteDeps,
  actor: CurrentUserContext,
  moduleKey: string,
): Promise<void> {
  assertManagedModule(moduleKey);
  await assertModuleAccessPolicy(
    moduleAccessPolicyDeps(deps.db, deps.access),
    actor,
    moduleKey,
    "manage",
  );
}

/**
 * Gate two, for the two paths that CHANGE an owner's groups. The module owner's
 * memberships may only be edited by the owner themselves or by an org owner —
 * a module manager who is neither is refused. `removeMember` deliberately does
 * not use this: removing the owner from their own module is refused outright.
 */
export function assertMayEditOwnerMemberships(
  actor: CurrentUserContext,
  targetUserId: string,
  ownerUserId: string | null,
): void {
  if (ownerUserId === null || targetUserId !== ownerUserId) return;
  if (!actor.isOrgOwner && actor.userId !== ownerUserId) {
    throw new ForbiddenException(
      "Only the module owner, an org owner, or a platform admin may modify the module owner's group memberships",
    );
  }
}

/**
 * The target's membership id, or null when they are not an ACTIVE member of the
 * org. Returns rather than throws: the caller picks the status code, and the
 * three callers disagree about it.
 */
export async function findActiveMembershipId(
  deps: FlatMemberWriteDeps,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const member = await deps.db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true, status: true },
  });
  if (!member || member.status !== "ACTIVE") return null;
  return member.id;
}

/** Every group id defined on this module, which is the set a write may span. */
export async function listModuleRoleIds(
  deps: FlatMemberWriteDeps,
  orgId: string,
  moduleKey: string,
): Promise<number[]> {
  const rows = await deps.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)));
  return rows.map((r) => r.id);
}

/**
 * Refuses a write that names a group belonging to some other module. Asked as
 * one `inArray` rather than a membership test per id, so a caller cannot make
 * this cost grow with the size of the request.
 */
export async function assertGroupsBelongToModule(
  deps: FlatMemberWriteDeps,
  orgId: string,
  moduleKey: string,
  groupIds: number[],
): Promise<void> {
  const valid = await deps.db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.orgId, orgId),
        eq(roles.moduleKey, moduleKey),
        inArray(roles.id, groupIds),
      ),
    );
  if (valid.length !== groupIds.length) {
    throw new BadRequestException(
      "One or more group IDs do not belong to this module",
    );
  }
}

/**
 * The two keys a membership change invalidates: the org's group list, and the
 * target's own session, which carries their resolved permissions.
 */
export async function invalidateMemberAccessCaches(
  deps: FlatMemberWriteDeps,
  orgId: string,
  userId: string,
): Promise<void> {
  await deps.cache.invalidate(CACHE_KEYS.rolesList(orgId));
  await deps.cache.invalidate(CACHE_KEYS.userSession(userId));
}
