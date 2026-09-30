import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
  tickets,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { AccessService } from "../../../access/access.service";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";

export async function assertProjectInOrg(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, orgId),
      isNull(projects.deletedAt),
    ),
    columns: { id: true },
  });
  if (!project) throw new NotFoundException("Project not found");
}

export async function assertTicketInProject(
  db: Db,
  orgId: string,
  projectId: number,
  ticketId: number,
): Promise<void> {
  const ticket = await db.query.tickets.findFirst({
    where: and(
      eq(tickets.id, ticketId),
      eq(tickets.projectId, projectId),
      eq(tickets.orgId, orgId),
      isNull(tickets.deletedAt),
    ),
    columns: { id: true },
  });
  if (!ticket) throw new NotFoundException("Ticket not found");
}

export async function resolveProjectAssignableMemberships(
  db: DbOrTx,
  orgId: string,
  projectId: number,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      membershipId: organizationMembers.id,
    })
    .from(projectMembers)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.id, projectMembers.membershipId),
        eq(organizationMembers.orgId, projectMembers.orgId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .where(
      and(
        eq(projectMembers.orgId, orgId),
        eq(projectMembers.projectId, projectId),
        inArray(organizationMembers.userId, uniqueUserIds),
      ),
    );
  return new Map(rows.map((row) => [row.userId, row.membershipId]));
}

export async function resolveProjectAccess(
  db: Db,
  access: Pick<AccessService, "resolveUserPermissions">,
  u: CurrentUserContext,
  projectId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<{ hasAccess: boolean; role: string | null }> {
  const projectRow = db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, u.orgId),
      ...(options.includeDeleted === true ? [] : [isNull(projects.deletedAt)]),
    ),
    columns: { managerMembershipId: true },
  });

  if (u.isOrgOwner) {
    if (!(await projectRow)) throw new NotFoundException("Project not found");
    return { hasAccess: true, role: "OWNER" };
  }

  const [perms, project] = await Promise.all([
    access.resolveUserPermissions(u.orgId, u.userId),
    projectRow,
  ]);
  if (!project) throw new NotFoundException("Project not found");
  if (perms.has("build:manage")) return { hasAccess: true, role: "OWNER" };

  const callerMid = actingMembershipId(u.principal);
  if (callerMid !== null && project.managerMembershipId === callerMid)
    return { hasAccess: true, role: "MANAGER" };

  const [membership, teamAccess] = await Promise.all([
    db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectMembers.membershipId),
          eq(organizationMembers.orgId, projectMembers.orgId),
          eq(organizationMembers.userId, u.userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.orgId, u.orgId)),
      )
      .limit(1),
    db
      .select({ id: projectTeamMembers.id })
      .from(projectTeamAssignments)
      .innerJoin(
        projectTeamMembers,
        and(
          eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
          eq(projectTeamMembers.orgId, projectTeamAssignments.orgId),
        ),
      )
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectTeamMembers.membershipId),
          eq(organizationMembers.orgId, projectTeamMembers.orgId),
          eq(organizationMembers.userId, u.userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, u.orgId),
        ),
      )
      .limit(1),
  ]);

  if (membership.length > 0) return { hasAccess: true, role: membership[0]?.role ?? null };
  if (teamAccess.length > 0) return { hasAccess: true, role: "MEMBER" };

  return { hasAccess: false, role: null };
}

export async function assertProjectAccess(
  db: Db,
  access: Pick<AccessService, "resolveUserPermissions">,
  u: CurrentUserContext,
  projectId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const { hasAccess } = await resolveProjectAccess(db, access, u, projectId, options);
  if (!hasAccess) throw new ForbiddenException("You do not have access to this project");
}

export async function assertCanManageProject(
  db: Db,
  access: Pick<AccessService, "resolveUserPermissions">,
  u: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, u.orgId),
      isNull(projects.deletedAt),
    ),
    columns: { managerMembershipId: true },
  });
  if (!project) throw new NotFoundException("Project not found");
  if (u.isOrgOwner) return;
  const perms = await access.resolveUserPermissions(u.orgId, u.userId);
  if (perms.has("build:manage")) return;
  const callerMid = actingMembershipId(u.principal);
  if (callerMid !== null && project.managerMembershipId === callerMid) return;
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.orgId, u.orgId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.membershipId, callerMid ?? -1),
      ),
    )
    .limit(1);
  if (membership?.role === "ADMIN") return;
  throw new ForbiddenException("You do not have permission to manage this project");
}
