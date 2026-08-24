import { eq, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { kbPages } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export interface VisibilityColumns {
  orgId: AnyColumn;
  visibility: AnyColumn;
  projectId: AnyColumn;
  createdById: AnyColumn;
}

export function visibleTo(
  columns: VisibilityColumns,
  user: CurrentUserContext,
  accessibleProjectIds: number[],
): SQL<unknown> {
  if (user.isOrgOwner) {
    return eq(columns.orgId, user.orgId);
  }
  const userId = user.userId;
  const unscoped = sql`(
    (${columns.visibility} IN ('org', 'public') AND ${columns.projectId} IS NULL)
    OR ${columns.createdById} = ${userId}
  )`;
  if (accessibleProjectIds.length === 0) return unscoped;
  const projectIdList = sql.join(
    accessibleProjectIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`(
    ${unscoped}
    OR (${columns.projectId} IS NOT NULL AND ${columns.projectId} = ANY(ARRAY[${projectIdList}]::int[]))
  )`;
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
    },
    user,
    accessibleProjectIds,
  );
}
