import { isNull, sql, type SQL } from "drizzle-orm";
import { tickets } from "../../../db/schema";

export function buildAssigneeFilter(
  orgId: string,
  userIds: string[],
  includeUnassigned: boolean,
): SQL<unknown> | undefined {
  if (!includeUnassigned && userIds.length === 0) return undefined;

  if (includeUnassigned && userIds.length === 0) {
    return isNull(tickets.assigneeMembershipId);
  }

  const memberIdList = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );

  if (!includeUnassigned) {
    return sql`${tickets.assigneeMembershipId} IN (
      SELECT id FROM organization_members
      WHERE org_id = ${orgId} AND user_id IN (${memberIdList})
    )`;
  }

  return sql`EXISTS (
    SELECT 1 WHERE ${tickets.assigneeMembershipId} IS NULL
    UNION ALL
    SELECT 1 FROM organization_members om
    WHERE om.id = ${tickets.assigneeMembershipId}
      AND om.org_id = ${orgId}
      AND om.user_id IN (${memberIdList})
  )`;
}
