import { sql, type SQL } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projectTeamAssignments,
  projectTeamMembers,
  projects,
  tickets,
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
      INNER JOIN ${organizationMembers}
        ON ${organizationMembers.id} = ${projectMembers.membershipId}
        AND ${organizationMembers.orgId} = ${projectMembers.orgId}
        AND ${organizationMembers.status} = ${"ACTIVE"}
      WHERE ${projectMembers.orgId} = ${orgId}
        AND ${projectMembers.membershipId} = ${membershipId}
    )
    OR ${projects.id} IN (
      SELECT ${projectTeamAssignments.projectId}
      FROM ${projectTeamAssignments}
      INNER JOIN ${projectTeamMembers}
        ON ${projectTeamMembers.teamId} = ${projectTeamAssignments.teamId}
        AND ${projectTeamMembers.orgId} = ${projectTeamAssignments.orgId}
      INNER JOIN ${organizationMembers}
        ON ${organizationMembers.id} = ${projectTeamMembers.membershipId}
        AND ${organizationMembers.orgId} = ${projectTeamMembers.orgId}
        AND ${organizationMembers.status} = ${"ACTIVE"}
      WHERE ${projectTeamAssignments.orgId} = ${orgId}
        AND ${projectTeamMembers.membershipId} = ${membershipId}
    )
  )`;
}

export function reachableTicketProjectsSql(orgId: string, membershipId: number): SQL<unknown> {
  return sql`${tickets.projectId} IN (SELECT ${projects.id} FROM ${projects} WHERE ${projects.orgId} = ${orgId} AND ${reachableProjectsSql(orgId, membershipId)})`;
}
