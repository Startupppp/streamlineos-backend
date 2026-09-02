import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { rolePermissionGrants, userPermissionGrants } from "../../db/schema";
import type { DataScope } from "./access.types";

export type SafeAccessTableRead = <Result>(
  read: () => PromiseLike<Result>,
  fallback: Result,
) => Promise<Result>;

/** One page of a grant drain. Pages, never a cap: see the two functions below. */
const GRANT_PAGE_SIZE = 500;

/** Sorts below every generated uuid, so the first page needs no special case. */
const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

export interface DrainedRoleGrant {
  roleId: number;
  permissionKey: string;
  scope: DataScope;
}

export interface DrainedUserGrant {
  permissionKey: string;
  scope: DataScope;
}

/**
 * Every `(role, key)` grant the member's roles carry, drained by keyset.
 *
 * This was a bare, unordered `.limit(500)`. One row per (role, key) across
 * every role held, and the 14 module-admin rungs sum to 564 keys — so a member
 * holding nine of them silently lost permissions past the 500th, and with no
 * `ORDER BY`, a *different* set on each request. An authorization decision that
 * is both wrong and non-deterministic, raising no error either way. A larger cap
 * is the same defect with a later trigger.
 */
export async function drainRolePermissionGrants(
  db: Db,
  safeAccessTableRead: SafeAccessTableRead,
  orgId: string,
  roleIdList: readonly number[],
): Promise<DrainedRoleGrant[]> {
  const drained: DrainedRoleGrant[] = [];
  let afterId = 0;
  for (;;) {
    const page = await safeAccessTableRead(
      () =>
        db
          .select({
            id: rolePermissionGrants.id,
            roleId: rolePermissionGrants.roleId,
            permissionKey: rolePermissionGrants.permissionKey,
            scope: rolePermissionGrants.scope,
          })
          .from(rolePermissionGrants)
          .where(
            and(
              eq(rolePermissionGrants.orgId, orgId),
              inArray(rolePermissionGrants.roleId, [...roleIdList]),
              gt(rolePermissionGrants.id, afterId),
            ),
          )
          .orderBy(asc(rolePermissionGrants.id))
          .limit(GRANT_PAGE_SIZE),
      [] as {
        id: number;
        roleId: number;
        permissionKey: string;
        scope: DataScope;
      }[],
    );
    for (const row of page)
      drained.push({
        roleId: row.roleId,
        permissionKey: row.permissionKey,
        scope: row.scope,
      });
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    afterId = last.id;
  }
}

/**
 * Every per-person grant the membership carries, drained by keyset.
 *
 * The same defect as above, one grant path over, and it survived the first
 * repair. The key space here is `(org_id, membership_id, permission_key)`, up
 * to one row per catalog key, so a person carrying more grants than a page
 * silently lost the remainder — and with no `ORDER BY`, a *different* remainder
 * on each request.
 */
export async function drainUserPermissionGrants(
  db: Db,
  safeAccessTableRead: SafeAccessTableRead,
  orgId: string,
  membershipId: number,
): Promise<DrainedUserGrant[]> {
  const drained: DrainedUserGrant[] = [];
  let afterId = UUID_ZERO;
  for (;;) {
    const page = await safeAccessTableRead(
      () =>
        db
          .select({
            id: userPermissionGrants.id,
            permissionKey: userPermissionGrants.permissionKey,
            scope: userPermissionGrants.scope,
          })
          .from(userPermissionGrants)
          .where(
            and(
              eq(userPermissionGrants.orgId, orgId),
              eq(userPermissionGrants.organizationMembershipId, membershipId),
              gt(userPermissionGrants.id, afterId),
            ),
          )
          .orderBy(asc(userPermissionGrants.id))
          .limit(GRANT_PAGE_SIZE),
      [] as { id: string; permissionKey: string; scope: DataScope }[],
    );
    for (const row of page)
      drained.push({ permissionKey: row.permissionKey, scope: row.scope });
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    afterId = last.id;
  }
}
