import { isNull, sql, type SQL } from "drizzle-orm";
import { tickets } from "../../../db/schema";

export type AssigneeFilter =
  | { kind: "single"; clause: SQL<unknown> }
  | { kind: "union"; nullBranch: SQL<unknown>; inBranch: SQL<unknown> };

export function buildAssigneeFilter(
  orgId: string,
  userIds: string[],
  includeUnassigned: boolean,
): AssigneeFilter | undefined {
  if (!includeUnassigned && userIds.length === 0) return undefined;

  if (includeUnassigned && userIds.length === 0) {
    return { kind: "single", clause: isNull(tickets.assigneeMembershipId) };
  }

  const memberIdList = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const inBranch = sql`${tickets.assigneeMembershipId} IN (
    SELECT id FROM organization_members
    WHERE org_id = ${orgId} AND user_id IN (${memberIdList})
  )`;

  if (!includeUnassigned) {
    return { kind: "single", clause: inBranch };
  }

  return {
    kind: "union",
    nullBranch: isNull(tickets.assigneeMembershipId),
    inBranch,
  };
}
