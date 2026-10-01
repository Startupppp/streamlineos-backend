import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { actingMembershipId, systemJobCovers } from "../../../../common/auth/principal";
import type { AccessService } from "../../../access/access.service";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import type { ScopedRead } from "../../../access/scoped-read";
import { resolveTicketsScope, ticketScope, ticketsScopeIsUnrestricted } from "../lib/tickets-scope";
import type { ProjectAccessCache } from "../../reachability/project-access-cache";

export type TicketReadAccess = Pick<AccessService, "scopeFor" | "resolveUserPermissions">;

export async function assertProjectInOrg(
  db: Db,
  orgId: string,
  projectId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, orgId),
      ...(options.includeDeleted === true ? [] : [isNull(projects.deletedAt)]),
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

export async function authorizeProjectTicketRead(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  projectId: number,
  cache?: ProjectAccessCache,
): Promise<ScopedRead> {
  const resolve = () => resolveProjectAccess(db, access, actor, projectId);
  const [{ hasAccess }, read] = await Promise.all([
    cache ? cache.get(actor.orgId, actor.userId, projectId, resolve) : resolve(),
    resolveTicketsScope(access, actor),
  ]);
  if (!hasAccess) throw new NotFoundException("Not found");
  return read;
}

export async function assertProjectVisible(
  db: Db,
  access: Pick<AccessService, "resolveUserPermissions">,
  actor: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess } = await resolveProjectAccess(db, access, actor, projectId);
  if (!hasAccess) throw new NotFoundException("Not found");
}

export async function assertCanDeleteProject(
  access: Pick<AccessService, "resolveUserPermissions">,
  actor: CurrentUserContext,
): Promise<void> {
  if (actor.isOrgOwner) return;
  const perms = await access.resolveUserPermissions(actor.orgId, actor.userId);
  if (!perms.has("build:delete"))
    throw new ForbiddenException("Only organization owners can delete projects");
}

export type RecordAuthor = { membershipId: number | null } | { userId: string | null };

export async function assertCanModifyAuthoredRecord(
  access: Pick<AccessService, "resolveUserPermissions">,
  actor: CurrentUserContext,
  author: RecordAuthor,
  managePermission: string | null,
  message: string,
): Promise<void> {
  const isAuthor =
    "membershipId" in author
      ? author.membershipId !== null && actingMembershipId(actor.principal) === author.membershipId
      : author.userId === actor.userId;
  if (isAuthor || actor.isOrgOwner) return;
  if (managePermission !== null) {
    const perms = await access.resolveUserPermissions(actor.orgId, actor.userId);
    if (perms.has(managePermission)) return;
  }
  throw new ForbiddenException(message);
}

export async function assertProjectAggregateAccess(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
): Promise<void> {
  if (actor.principal.kind === "system-job") {
    if (!systemJobCovers(actor.principal, "build:manage"))
      throw new ForbiddenException("Job cannot read project aggregates");
    await assertProjectInOrg(db, actor.orgId, projectId);
    return;
  }
  const project = await resolveProjectAccess(db, access, actor, projectId);
  if (!project.hasAccess) throw new ForbiddenException("Not authorized to view this project");
  if (!(await ticketsScopeIsUnrestricted(access, actor)))
    throw new ForbiddenException("Project-wide reports require access to all project tickets");
}

export async function lockProjectTicketMutation(db: Db, orgId: string, projectId: number): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`build:tickets:${orgId}:${projectId}`}, 0))`,
  );
}

export async function authorizeTicketMutation(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
) {
  const projectAccess = await resolveProjectAccess(db, access, actor, projectId);
  if (!projectAccess.hasAccess) throw new ForbiddenException("Not authorized to update this project");
  const read = await resolveTicketsScope(access, actor);
  const predicate = read.compose(
    { tenant: tickets.orgId, scope: ticketScope(read.orgId, read.actorId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
  return { role: projectAccess.role, predicate };
}

export async function readMutationTickets(
  db: Db,
  actor: CurrentUserContext,
  projectId: number,
  ids: number[],
  policy: Awaited<ReturnType<typeof authorizeTicketMutation>>,
) {
  const rows = await db
    .select({
      id: tickets.id,
      status: tickets.status,
      rank: tickets.rank,
      version: tickets.version,
      assigneeMembershipId: tickets.assigneeMembershipId,
      dueDate: tickets.dueDate,
      priority: tickets.priority,
      points: tickets.points,
      epicId: tickets.epicId,
      cycleId: tickets.cycleId,
      allowed: sql<boolean>`${policy.predicate}`,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, actor.orgId),
        eq(tickets.projectId, projectId),
        inArray(tickets.id, ids),
        isNull(tickets.deletedAt),
      ),
    )
    .orderBy(tickets.id)
    .for("update");
  if (rows.length !== ids.length) throw new NotFoundException("One or more ticket IDs not found in this project");
  if (rows.some((row) => !row.allowed)) throw new ForbiddenException("Ticket is outside your data scope");
  return rows;
}

export async function assertTicketReadAccess(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  projectId: number,
  ticketId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const read = await resolveTicketsScope(access, actor);
  const allowed = read.compose(
    { tenant: tickets.orgId, scope: ticketScope(read.orgId, read.actorId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
  const [ticket] = await db
    .select({
      id: tickets.id,
      allowed: sql<boolean>`${allowed}`,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, actor.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.id, ticketId),
        ...(options.includeDeleted === true ? [] : [isNull(tickets.deletedAt)]),
      ),
    )
    .limit(1);
  if (!ticket) throw new NotFoundException("Ticket not found");
  const projectAccess = await resolveProjectAccess(db, access, actor, projectId, options);
  if (!projectAccess.hasAccess || !ticket.allowed)
    throw new ForbiddenException("Ticket is outside your access scope");
}

export async function assertCanManageProject(
  db: Db,
  access: Pick<AccessService, "resolveUserPermissions">,
  u: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess, role } = await resolveProjectAccess(db, access, u, projectId);
  if (!hasAccess || (role !== "OWNER" && role !== "MANAGER" && role !== "ADMIN"))
    throw new ForbiddenException("You do not have permission to manage this project");
}
