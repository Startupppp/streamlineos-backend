import { sql, type SQL } from "drizzle-orm";
import {
  projectMembers,
  projectTeamAssignments,
  projectTeamMembers,
  projects,
} from "../../../db/schema";

export function reachableProjectsSql(
  orgId: string,
  membershipId: number,
): SQL<unknown> {
  return sql`(
    ${projects.managerMembershipId} = ${membershipId}
    OR ${projects.id} IN (
      SELECT ${projectMembers.projectId}
      FROM ${projectMembers}
      WHERE ${projectMembers.orgId} = ${orgId}
        AND ${projectMembers.membershipId} = ${membershipId}
    )
    OR ${projects.id} IN (
      SELECT ${projectTeamAssignments.projectId}
      FROM ${projectTeamAssignments}
      INNER JOIN ${projectTeamMembers}
        ON ${projectTeamMembers.teamId} = ${projectTeamAssignments.teamId}
        AND ${projectTeamMembers.orgId} = ${projectTeamAssignments.orgId}
      WHERE ${projectTeamAssignments.orgId} = ${orgId}
        AND ${projectTeamMembers.membershipId} = ${membershipId}
    )
  )`;
}
