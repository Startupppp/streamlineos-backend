import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export function pageVisibleTo(
  user: CurrentUserContext,
  accessibleProjectIds?: number[],
): SQL<unknown> {
  if (user.isOrgOwner) {
    return eq(kbPages.orgId, user.orgId);
  }
  const userId = user.userId;
  if (accessibleProjectIds && accessibleProjectIds.length > 0) {
    const projectIdList = sql.join(
      accessibleProjectIds.map((id) => sql`${id}`),
      sql`, `,
    );
    return sql`(
      (${kbPages.visibility} = 'org' AND ${kbPages.projectId} IS NULL)
      OR ${kbPages.createdById} = ${userId}
      OR (${kbPages.projectId} IS NOT NULL AND ${kbPages.projectId} = ANY(ARRAY[${projectIdList}]::int[]))
    )`;
  }
  return sql`(${kbPages.visibility} <> 'private' OR ${kbPages.createdById} = ${userId})`;
}
