import { and, asc, desc, eq, gt, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  organizationMembers,
  userDelegationPermissions,
  userDelegations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { ListDelegationsQuery } from "../dto/delegation.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";

/**
 * The read half of delegations.
 *
 * Listing may assume nothing about the caller beyond an org id and a user id:
 * a request from somebody who is not an active member is not an error here, it
 * is an empty page. The write half (create/revoke in DelegationsService) is the
 * opposite — it runs inside a tenant transaction, refuses with NotFound or
 * Forbidden, bumps the permissions version and busts the delegatee's session.
 * Nothing in this file writes, transacts or invalidates, so its only failure
 * mode is "no rows".
 */
export interface DelegationListingDeps {
  readonly db: Db;
}

/**
 * Storage keys a delegation on the two memberships; the API has always spoken
 * user ids, and callers, audit metadata and the frontend all still do. The two
 * joins below are the whole translation, so the shape crossing this service's
 * boundary is unchanged by the move.
 */
export const delegatorMember = alias(organizationMembers, "delegator_member");
export const delegateeMember = alias(organizationMembers, "delegatee_member");

export const delegationSelection = {
  id: userDelegations.id,
  orgId: userDelegations.orgId,
  delegatorMembershipId: userDelegations.delegatorMembershipId,
  delegateeMembershipId: userDelegations.delegateeMembershipId,
  delegatorId: delegatorMember.userId,
  delegateeId: delegateeMember.userId,
  startsAt: userDelegations.startsAt,
  endsAt: userDelegations.endsAt,
  reason: userDelegations.reason,
  status: userDelegations.status,
  createdAt: userDelegations.createdAt,
  revokedAt: userDelegations.revokedAt,
  revokedBy: userDelegations.revokedBy,
} as const;

export const joinDelegatorMember = and(
  eq(delegatorMember.orgId, userDelegations.orgId),
  eq(delegatorMember.id, userDelegations.delegatorMembershipId),
);
export const joinDelegateeMember = and(
  eq(delegateeMember.orgId, userDelegations.orgId),
  eq(delegateeMember.id, userDelegations.delegateeMembershipId),
);

type DelegationRow = typeof userDelegations.$inferSelect & {
  delegatorId: string;
  delegateeId: string;
};
type DelegationDirection = "received" | "given";
type DelegationLifecycle = "ACTIVE" | "SCHEDULED" | "EXPIRED" | "REVOKED";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function resolveLifecycle(
  row: DelegationRow,
  now: Date,
): DelegationLifecycle {
  if (row.status !== "ACTIVE") return "REVOKED";
  if (row.startsAt > now) return "SCHEDULED";
  if (row.endsAt <= now) return "EXPIRED";
  return "ACTIVE";
}

async function withPermissions(
  deps: DelegationListingDeps,
  rows: DelegationRow[],
  now: Date,
) {
  if (rows.length === 0) return [];
  const participantMembershipIds = Array.from(
    new Set(rows.flatMap((row) => [row.delegatorMembershipId, row.delegateeMembershipId])),
  );
  const [permissionRows, participantRows] = await Promise.all([
    deps.db
      .select({
        delegationId: userDelegationPermissions.delegationId,
        permissionKey: userDelegationPermissions.permissionKey,
      })
      .from(userDelegationPermissions)
      .where(
        and(
          eq(userDelegationPermissions.orgId, rows[0]!.orgId),
          inArray(
            userDelegationPermissions.delegationId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(
        asc(userDelegationPermissions.delegationId),
        asc(userDelegationPermissions.permissionKey),
      ),
    deps.db
      .select({
        membershipId: organizationMembers.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, rows[0]!.orgId),
          inArray(organizationMembers.id, participantMembershipIds),
        ),
      ),
  ]);
  const byDelegation = new Map<string, string[]>();
  for (const row of permissionRows) {
    const values = byDelegation.get(row.delegationId) ?? [];
    values.push(row.permissionKey);
    byDelegation.set(row.delegationId, values);
  }
  const nameByMembershipId = new Map(
    participantRows.map((member) => {
      const structuredName = [member.firstName, member.lastName]
        .filter(Boolean)
        .join(" ");
      return [member.membershipId, member.name?.trim() || structuredName || member.email];
    }),
  );
  return rows.map((row) => ({
    ...row,
    permissions: byDelegation.get(row.id) ?? [],
    delegatorName: nameByMembershipId.get(row.delegatorMembershipId) ?? null,
    delegateeName: nameByMembershipId.get(row.delegateeMembershipId) ?? null,
    lifecycle: resolveLifecycle(row, now),
  }));
}

export async function listDelegationsPage(
  deps: DelegationListingDeps,
  orgId: string,
  userId: string,
  direction: DelegationDirection,
  query: ListDelegationsQuery,
) {
  const now = new Date();
  const actorMembership = await deps.db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!actorMembership) {
    return {
      data: [],
      pagination: { limit: query.limit, nextCursor: null, hasMore: false },
    };
  }
  const actorMembershipId = actorMembership.id;
  const participantColumn =
    direction === "received"
      ? userDelegations.delegatorMembershipId
      : userDelegations.delegateeMembershipId;
  const actorColumn =
    direction === "received"
      ? userDelegations.delegateeMembershipId
      : userDelegations.delegatorMembershipId;
  const search = query.search?.trim();
  const searchPattern = search ? `%${escapeLike(search)}%` : null;
  const participantSearch = searchPattern
    ? or(
        ilike(userDelegations.reason, searchPattern),
        sql`EXISTS (
          SELECT 1
          FROM ${organizationMembers}
          INNER JOIN ${users} ON ${users.id} = ${organizationMembers.userId}
          WHERE ${organizationMembers.id} = ${participantColumn}
            AND ${organizationMembers.orgId} = ${orgId}
            AND (
              ${users.name} ILIKE ${searchPattern}
              OR ${users.email} ILIKE ${searchPattern}
              OR concat_ws(' ', ${users.firstName}, ${users.lastName}) ILIKE ${searchPattern}
            )
        )`,
      )
    : undefined;
  const position = decodeCursor(query.cursor);
  const conditions = and(
    eq(userDelegations.orgId, orgId),
    eq(actorColumn, actorMembershipId),
    direction === "received"
      ? and(
          eq(userDelegations.status, "ACTIVE"),
          lte(userDelegations.startsAt, now),
          gt(userDelegations.endsAt, now),
        )
      : undefined,
    participantSearch,
    position
      ? keysetBefore(userDelegations.createdAt, userDelegations.id, position)
      : undefined,
  );

  const rows = await deps.db
    .select(delegationSelection)
    .from(userDelegations)
    .innerJoin(delegatorMember, joinDelegatorMember)
    .innerJoin(delegateeMember, joinDelegateeMember)
    .where(conditions)
    .orderBy(desc(userDelegations.createdAt), desc(userDelegations.id))
    .limit(query.limit + 1);
  const page = buildCursorPage(rows, query.limit, (row) => ({
    sortValue: row.createdAt.toISOString(),
    id: row.id,
  }));

  return { ...page, data: await withPermissions(deps, page.data, now) };
}
