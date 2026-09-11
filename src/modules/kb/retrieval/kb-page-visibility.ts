import { eq, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";

export interface VisibilityColumns {
  orgId: AnyColumn;
  visibility: AnyColumn;
  projectId: AnyColumn;
  createdById: AnyColumn;
  createdByMembershipId?: AnyColumn;
}

/**
 * The tenant equality is emitted on BOTH branches, not only the owner's. It used to
 * be the owner's whole predicate and absent from everyone else's, so `chunkVisibleTo`
 * — the only candidate-side tenant carrier `pageVectorCandidates` had — bound no
 * `org_id` for an ordinary reader, and a covering index on an RLS table is unusable
 * without one (backend CLAUDE.md §7).
 */
export function visibleTo(
  columns: VisibilityColumns,
  user: CurrentUserContext,
  accessibleProjectIds: number[],
): SQL<unknown> {
  const tenant = eq(columns.orgId, user.orgId);
  if (user.isOrgOwner) return tenant;
  const userId = user.userId;
  const membershipId = user.principal === undefined ? null : actingMembershipId(user.principal);
  const unscoped = sql`(
    (${columns.visibility} IN ('org', 'public') AND ${columns.projectId} IS NULL)
    OR ${columns.createdById} = ${userId}
    ${membershipId == null || columns.createdByMembershipId === undefined ? sql`` : sql`OR ${columns.createdByMembershipId} = ${membershipId}`}
  )`;
  if (accessibleProjectIds.length === 0) return sql`(${tenant} AND ${unscoped})`;
  const projectIdList = sql.join(
    accessibleProjectIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`(${tenant} AND (
    ${unscoped}
    OR (${columns.projectId} IS NOT NULL AND ${columns.projectId} = ANY(ARRAY[${projectIdList}]::int[]))
  ))`;
}

export function pageVisibleTo(
  user: CurrentUserContext,
  accessibleProjectIds: number[],
): SQL<unknown> {
  return visibleTo(
    {
      orgId: kbPages.orgId,
      visibility: kbPages.visibility,
      projectId: kbPages.projectId,
      createdById: kbPages.createdById,
      createdByMembershipId: kbPages.createdByMembershipId,
    },
    user,
    accessibleProjectIds,
  );
}
