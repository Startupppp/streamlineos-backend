import { sql, type SQL } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projectTeamAssignments,
  projectTeamMembers,
  projects,
  tickets,
} from "../../../../db/schema";
import type { ScopedRead } from "../../../access/scoped-read";
import { ticketScope } from "../lib/tickets-scope";
import { PROJECTS_MANAGE_PERMISSION, PROJECTS_VIEW_PERMISSION, projectStanding } from "./projects-scope";

export type ProjectRelationship = {
  manages: SQL;
  memberRole: SQL<string | null>;
  onTeam: SQL;
};

function directMemberRows(orgId: string, membershipId: number): SQL {
  return sql`FROM ${projectMembers}
      INNER JOIN ${organizationMembers}
        ON ${organizationMembers.id} = ${projectMembers.membershipId}
        AND ${organizationMembers.orgId} = ${projectMembers.orgId}
        AND ${organizationMembers.status} = ${"ACTIVE"}
      WHERE ${projectMembers.orgId} = ${orgId}
        AND ${projectMembers.membershipId} = ${membershipId}`;
}

function teamMemberRows(orgId: string, membershipId: number): SQL {
  return sql`FROM ${projectTeamAssignments}
      INNER JOIN ${projectTeamMembers}
        ON ${projectTeamMembers.teamId} = ${projectTeamAssignments.teamId}
        AND ${projectTeamMembers.orgId} = ${projectTeamAssignments.orgId}
      INNER JOIN ${organizationMembers}
        ON ${organizationMembers.id} = ${projectTeamMembers.membershipId}
        AND ${organizationMembers.orgId} = ${projectTeamMembers.orgId}
        AND ${organizationMembers.status} = ${"ACTIVE"}
      WHERE ${projectTeamAssignments.orgId} = ${orgId}
        AND ${projectTeamMembers.membershipId} = ${membershipId}`;
}

function managesSql(membershipId: number): SQL {
  return sql`${projects.managerMembershipId} = ${membershipId}`;
}

function onTeamSql(orgId: string, membershipId: number): SQL {
  return sql`${projects.id} IN (
      SELECT ${projectTeamAssignments.projectId}
      ${teamMemberRows(orgId, membershipId)}
    )`;
}

export function projectRelationship(orgId: string, membershipId: number | null): ProjectRelationship {
  if (membershipId === null)
    return { manages: sql`false`, memberRole: sql<string | null>`NULL`, onTeam: sql`false` };
  return {
    manages: managesSql(membershipId),
    memberRole: sql<string | null>`(SELECT ${projectMembers.role} ${directMemberRows(orgId, membershipId)} AND ${projectMembers.projectId} = ${projects.id} LIMIT 1)`,
    onTeam: onTeamSql(orgId, membershipId),
  };
}

export function reachableProjectsSql(orgId: string, membershipId: number | null): SQL {
  if (membershipId === null) return sql`false`;
  return sql`(
    ${managesSql(membershipId)}
    OR ${projects.id} IN (
      SELECT ${projectMembers.projectId}
      ${directMemberRows(orgId, membershipId)}
    )
    OR ${onTeamSql(orgId, membershipId)}
  )`;
}

export function reachableTicketProjectsSql(orgId: string, membershipId: number | null): SQL {
  return sql`${tickets.projectId} IN (SELECT ${projects.id} FROM ${projects} WHERE ${projects.orgId} = ${orgId} AND ${reachableProjectsSql(orgId, membershipId)})`;
}

export function projectReachSql(standing: ScopedRead, orgId: string, membershipId: number | null): SQL {
  if (standing.unrestricted) return sql`true`;
  if (standing.denied) return sql`false`;
  return reachableProjectsSql(orgId, membershipId);
}

export function projectReachFor(
  readFor: (permissionKey: string) => ScopedRead,
  orgId: string,
  membershipId: number | null,
): SQL {
  const standing = projectStanding(readFor(PROJECTS_MANAGE_PERMISSION), readFor(PROJECTS_VIEW_PERMISSION));
  return projectReachSql(standing, orgId, membershipId);
}

export function ticketProjectReachableSql(orgId: string, projectReach: SQL, includeDeletedProjects = false): SQL {
  const live = includeDeletedProjects ? sql`` : sql` AND ${projects.deletedAt} IS NULL`;
  return sql`(${tickets.projectId} IS NULL OR ${tickets.projectId} IN (SELECT ${projects.id} FROM ${projects} WHERE ${projects.orgId} = ${orgId}${live} AND ${projectReach}))`;
}

export function ticketInScopeSql(ticketRead: ScopedRead): SQL {
  return ticketRead.compose(
    { tenant: tickets.orgId, scope: ticketScope(ticketRead.orgId, ticketRead.actorId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
}

export function ticketVisibleSql(ticketRead: ScopedRead, projectReach: SQL): SQL {
  return sql`(${ticketInScopeSql(ticketRead)} AND ${ticketProjectReachableSql(ticketRead.orgId, projectReach)})`;
}
