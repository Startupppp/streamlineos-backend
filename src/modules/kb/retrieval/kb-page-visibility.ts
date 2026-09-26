import { eq, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";

export interface VisibilityColumns {
  orgId: AnyColumn;
  visibility: AnyColumn;
  projectId: AnyColumn;
  createdById: AnyColumn;
  createdByMembershipId?: AnyColumn;
}

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
