import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  rolePermissionGrants,
  userDelegationPermissions,
  userDelegations,
  userPermissionGrants,
} from "../../db/schema";
import type { DataScope } from "./access.types";

/**
 * A read of an RBAC table. It takes no fallback on purpose: see
 * `AccessService.readAccessTable` for why a permissions read that fails must
 * throw rather than resolve to an empty set.
 */
export type ReadAccessTable = <Result>(
  read: () => PromiseLike<Result>,
) => Promise<Result>;

/** One page of a grant drain. Pages, never a cap: see the two functions below. */
const GRANT_PAGE_SIZE = 500;

/** Sorts below every generated uuid, so the first page needs no special case. */
const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

/**
 * The empty string is the minimum of `text` under every collation, so it is the
 * one sentinel that is safe for a keyset over ids this module does not generate
 * itself. `user_delegations.id` is plain `text`, not `uuid`.
 */
const TEXT_MIN = "";

export interface DrainedRoleGrant {
  roleId: number;
  permissionKey: string;
  scope: DataScope;
}

export interface DrainedUserGrant {
  permissionKey: string;
  scope: DataScope;
}

export interface DrainedDelegatedGrant {
  permissionKey: string;
  startsAt: Date;
  endsAt: Date;
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
  readAccessTable: ReadAccessTable,
  orgId: string,
  roleIdList: readonly number[],
): Promise<DrainedRoleGrant[]> {
  const drained: DrainedRoleGrant[] = [];
  let afterId = 0;
  for (;;) {
    const page = await readAccessTable(
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
  readAccessTable: ReadAccessTable,
  orgId: string,
  membershipId: number,
): Promise<DrainedUserGrant[]> {
  const drained: DrainedUserGrant[] = [];
  let afterId = UUID_ZERO;
  for (;;) {
    const page = await readAccessTable(
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
    );
    for (const row of page)
      drained.push({ permissionKey: row.permissionKey, scope: row.scope });
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    afterId = last.id;
  }
}

/**
 * Every permission the membership holds by delegation, drained by keyset.
 *
 * The same defect a third time, and here the cap sat on the wrong side of a
 * fan-out. `createDelegationSchema` caps ONE delegation at 200 permissions, but
 * nothing caps how many delegations are concurrently ACTIVE against the same
 * delegatee, and the read filtered on `delegatee_membership_id` + status +
 * expiry only — never on a delegation id. An ops lead covering four colleagues
 * on leave holds 4 x 200 rows; 500 came back, and with no `ORDER BY` a
 * *different* 500 on each request. The answer is then cached under
 * `accessPerms(orgId, userId, version)` for that version's lifetime.
 *
 * `user_delegation_permissions` has NO `id` column — its primary key IS
 * `(delegation_id, permission_key)` — so the keyset is that composite pair,
 * written in expanded form rather than as a row-value comparison so the
 * predicate is ordinary Drizzle and type-checks like the two drains above.
 */
export async function drainDelegatedPermissionGrants(
  db: Db,
  readAccessTable: ReadAccessTable,
  orgId: string,
  membershipId: number,
  now: Date,
): Promise<DrainedDelegatedGrant[]> {
  const drained: DrainedDelegatedGrant[] = [];
  let afterDelegationId = TEXT_MIN;
  let afterPermissionKey = TEXT_MIN;
  for (;;) {
    const page = await readAccessTable(
      () =>
        db
          .select({
            delegationId: userDelegationPermissions.delegationId,
            permissionKey: userDelegationPermissions.permissionKey,
            startsAt: userDelegations.startsAt,
            endsAt: userDelegations.endsAt,
          })
          .from(userDelegationPermissions)
          .innerJoin(
            userDelegations,
            and(
              eq(userDelegations.orgId, userDelegationPermissions.orgId),
              eq(userDelegations.id, userDelegationPermissions.delegationId),
            ),
          )
          .where(
            and(
              eq(userDelegations.orgId, orgId),
              eq(userDelegations.delegateeMembershipId, membershipId),
              eq(userDelegations.status, "ACTIVE"),
              gt(userDelegations.endsAt, now),
              or(
                gt(userDelegationPermissions.delegationId, afterDelegationId),
                and(
                  eq(userDelegationPermissions.delegationId, afterDelegationId),
                  gt(
                    userDelegationPermissions.permissionKey,
                    afterPermissionKey,
                  ),
                ),
              ),
            ),
          )
          .orderBy(
            asc(userDelegationPermissions.delegationId),
            asc(userDelegationPermissions.permissionKey),
          )
          .limit(GRANT_PAGE_SIZE),
    );
    for (const row of page)
      drained.push({
        permissionKey: row.permissionKey,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      });
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    afterDelegationId = last.delegationId;
    afterPermissionKey = last.permissionKey;
  }
}
