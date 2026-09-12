import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  groupRoleAssignments,
  moduleOwnerships,
  principalGroupMembers,
  roleAssignments,
  rolePermissionGrants,
  userDelegationPermissions,
  userDelegations,
  userPermissionGrants,
} from "../../db/schema";
import { logger } from "../../common/logger/logger.service";
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
export const GRANT_PAGE_SIZE = 500;

/** Sorts below every generated uuid, so the first page needs no special case. */
export const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

/**
 * The empty string is the minimum of `text` under every collation, so it is the
 * one sentinel that is safe for a keyset over ids this module does not generate
 * itself. `user_delegations.id` is plain `text`, not `uuid`.
 */
const TEXT_MIN = "";

/**
 * The one paging loop in this file. Every drain below reads `GRANT_PAGE_SIZE`
 * rows at a time and advances a keyset cursor until a page comes back short, so
 * a tenant whose rows fit inside one page still costs exactly one query, and a
 * tenant past the boundary loses nothing instead of losing the remainder.
 *
 * Termination is a property of the read, not of a counter: `readPage` filters on
 * `cursor > after` and orders by that same column, so every row of the next page
 * sorts strictly after the last row of this one. The non-advance check exists for
 * the case that invariant is broken — a projection that forgot to select the
 * cursor column, a fake that ignores the predicate — and it stops and says so
 * rather than spinning. Nothing here truncates in silence.
 */
export async function drainByKeyset<Row, Cursor>(
  firstCursor: Cursor,
  readPage: (after: Cursor) => PromiseLike<Row[]>,
  cursorOf: (row: Row) => Cursor,
): Promise<Row[]> {
  const drained: Row[] = [];
  let after = firstCursor;
  for (;;) {
    const page = await readPage(after);
    for (const row of page) drained.push(row);
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    const next = cursorOf(last);
    if (next === after) {
      logger.warn(
        "access: keyset drain cursor did not advance - stopping the drain",
        { rows: drained.length },
      );
      return drained;
    }
    after = next;
  }
}

export interface DrainedRoleAssignment {
  roleId: number;
  expiresAt: Date | null;
}

export interface DrainedGroupMembership {
  principalGroupId: string;
}

export interface DrainedModuleOwnership {
  moduleKey: string;
}

export interface DrainedGroupRoleAssignment {
  roleId: number;
}

/**
 * Every unexpired role the membership is directly assigned, drained by keyset.
 *
 * This was `.limit(500)`. The unique index is `(org_id, membership_id, role_id)`,
 * so the row count is bounded by the number of roles the organisation has — and
 * roles are created through the module-access group API, not only seeded from the
 * 13 templates. Past the cap the member simply resolved without those roles: no
 * error, no log, no flag, and truncation is always privilege LOSS, so the answer
 * was an intermittent denial of standing the member actually held.
 *
 * The `expiresAt` guard stays inside the page predicate rather than being applied
 * after the read: filtering afterwards would spend the page on rows that were
 * already expired and push live ones past the boundary.
 */
export async function drainRoleAssignments(
  db: Db,
  readAccessTable: ReadAccessTable,
  orgId: string,
  membershipId: number,
  now: Date,
): Promise<DrainedRoleAssignment[]> {
  const rows = await drainByKeyset(
    UUID_ZERO,
    (after) =>
      readAccessTable(
        () =>
          db
            .select({
              id: roleAssignments.id,
              roleId: roleAssignments.roleId,
              expiresAt: roleAssignments.expiresAt,
            })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, orgId),
                eq(roleAssignments.organizationMembershipId, membershipId),
                or(
                  isNull(roleAssignments.expiresAt),
                  gt(roleAssignments.expiresAt, now),
                ),
                gt(roleAssignments.id, after),
              ),
            )
            .orderBy(asc(roleAssignments.id))
            .limit(GRANT_PAGE_SIZE),
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({ roleId: row.roleId, expiresAt: row.expiresAt }));
}

/**
 * Every principal group the membership belongs to, drained by keyset.
 *
 * This was `.limit(500)`, and it is the worst of the four to truncate: the group
 * ids it returns are the input to the group-role read, so one dropped group takes
 * every role that group carries with it, and every permission those roles grant.
 */
export async function drainPrincipalGroupMemberships(
  db: Db,
  readAccessTable: ReadAccessTable,
  orgId: string,
  membershipId: number,
): Promise<DrainedGroupMembership[]> {
  const rows = await drainByKeyset(
    UUID_ZERO,
    (after) =>
      readAccessTable(
        () =>
          db
            .select({
              id: principalGroupMembers.id,
              principalGroupId: principalGroupMembers.principalGroupId,
            })
            .from(principalGroupMembers)
            .where(
              and(
                eq(principalGroupMembers.orgId, orgId),
                eq(
                  principalGroupMembers.organizationMembershipId,
                  membershipId,
                ),
                gt(principalGroupMembers.id, after),
              ),
            )
            .orderBy(asc(principalGroupMembers.id))
            .limit(GRANT_PAGE_SIZE),
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({ principalGroupId: row.principalGroupId }));
}

/**
 * Every module the membership owns, drained by keyset.
 *
 * This was `.limit(100)` — the lowest of the four caps and the only one that was
 * not 500. Ownership expands at resolution into every delegable permission the
 * module scopes, so a truncated ownership row is not one missing key but a whole
 * module's worth of them.
 */
export async function drainModuleOwnerships(
  db: Db,
  readAccessTable: ReadAccessTable,
  orgId: string,
  membershipId: number,
): Promise<DrainedModuleOwnership[]> {
  const rows = await drainByKeyset(
    UUID_ZERO,
    (after) =>
      readAccessTable(
        () =>
          db
            .select({
              id: moduleOwnerships.id,
              moduleKey: moduleOwnerships.moduleKey,
            })
            .from(moduleOwnerships)
            .where(
              and(
                eq(moduleOwnerships.orgId, orgId),
                eq(moduleOwnerships.ownerMembershipId, membershipId),
                gt(moduleOwnerships.id, after),
              ),
            )
            .orderBy(asc(moduleOwnerships.id))
            .limit(GRANT_PAGE_SIZE),
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({ moduleKey: row.moduleKey }));
}

/**
 * Every role reached through the membership's principal groups, drained by keyset.
 *
 * This was `.limit(500)` over a fan-out: one row per `(group, role)` across every
 * group drained above, so the cap was crossed by group count times roles per
 * group, not by either alone.
 */
export async function drainGroupRoleAssignments(
  db: Db,
  readAccessTable: ReadAccessTable,
  orgId: string,
  groupIds: readonly string[],
): Promise<DrainedGroupRoleAssignment[]> {
  const rows = await drainByKeyset(
    UUID_ZERO,
    (after) =>
      readAccessTable(
        () =>
          db
            .select({
              id: groupRoleAssignments.id,
              roleId: groupRoleAssignments.roleId,
            })
            .from(groupRoleAssignments)
            .where(
              and(
                eq(groupRoleAssignments.orgId, orgId),
                inArray(groupRoleAssignments.principalGroupId, [...groupIds]),
                gt(groupRoleAssignments.id, after),
              ),
            )
            .orderBy(asc(groupRoleAssignments.id))
            .limit(GRANT_PAGE_SIZE),
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({ roleId: row.roleId }));
}

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
  const rows = await drainByKeyset(
    0,
    (afterId) =>
      readAccessTable(
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
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({
    roleId: row.roleId,
    permissionKey: row.permissionKey,
    scope: row.scope,
  }));
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
  const rows = await drainByKeyset(
    UUID_ZERO,
    (afterId) =>
      readAccessTable(
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
      ),
    (row) => row.id,
  );
  return rows.map((row) => ({
    permissionKey: row.permissionKey,
    scope: row.scope,
  }));
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
  const rows = await drainByKeyset(
    { delegationId: TEXT_MIN, permissionKey: TEXT_MIN },
    (after) =>
      readAccessTable(
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
                  gt(
                    userDelegationPermissions.delegationId,
                    after.delegationId,
                  ),
                  and(
                    eq(
                      userDelegationPermissions.delegationId,
                      after.delegationId,
                    ),
                    gt(
                      userDelegationPermissions.permissionKey,
                      after.permissionKey,
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
      ),
    (row) => ({
      delegationId: row.delegationId,
      permissionKey: row.permissionKey,
    }),
  );
  return rows.map((row) => ({
    permissionKey: row.permissionKey,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  }));
}
