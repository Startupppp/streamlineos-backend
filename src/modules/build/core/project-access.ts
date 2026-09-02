import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";

export async function resolveProjectAccess(
  db: Db,
  access: AccessService,
  u: CurrentUserContext,
  projectId: number,
): Promise<{ hasAccess: boolean; role: string | null }> {
  if (u.isOrgOwner) return { hasAccess: true, role: "OWNER" };

  const [perms, project] = await Promise.all([
    access.resolveUserPermissions(u.orgId, u.userId),
    db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.orgId, u.orgId),
        isNull(projects.deletedAt),
      ),
      columns: { managerMembershipId: true },
    }),
  ]);
  if (!project) throw new NotFoundException("Project not found");
  if (perms.has("build:manage")) return { hasAccess: true, role: "OWNER" };

  const callerMid = actingMembershipId(u.principal);
  if (callerMid !== null && project.managerMembershipId === callerMid)
    return { hasAccess: true, role: "MANAGER" };

  const membership = await db
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
    .limit(1);
  if (membership.length > 0)
    return { hasAccess: true, role: membership[0]?.role ?? null };

  const teamAccess = await db
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
    .limit(1);
  if (teamAccess.length > 0) return { hasAccess: true, role: "MEMBER" };

  return { hasAccess: false, role: null };
}

export async function assertProjectAccess(
  db: Db,
  access: AccessService,
  u: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess } = await resolveProjectAccess(db, access, u, projectId);
  if (!hasAccess) throw new ForbiddenException("You do not have access to this project");
}
