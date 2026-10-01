import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { projects, tickets } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { accountableMembershipId, actingMembershipId, systemJobCovers } from "../../../../common/auth/principal";
import type { AccessService } from "../../../access/access.service";
import type { ScopedRead } from "../../../access/scoped-read";
import { resolveTicketsScope, ticketsScopeIsUnrestricted } from "../lib/tickets-scope";
import type { ProjectAccessCache } from "../../reachability/project-access-cache";
import { resolveProjectsScope } from "./projects-scope";
import {
  projectReachSql,
  projectRelationship,
  ticketInScopeSql,
  ticketProjectReachableSql,
  ticketVisibleSql,
} from "./project-relationship";

export type TicketReadAccess = Pick<AccessService, "scopeFor">;

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

export type ProjectState = "ACTIVE" | "COMPLETED" | "ARCHIVED";

export type ProjectAccess = {
  hasAccess: boolean;
  role: string | null;
  state: ProjectState;
  bypassesWorkflow: boolean;
};

type StandingAccess = Pick<AccessService, "scopeFor">;

const LOCKED_PROJECT_STATES: ReadonlySet<ProjectState> = new Set(["ARCHIVED", "COMPLETED"]);

export function assertProjectStateAllowsWrites(state: ProjectState): void {
  if (!LOCKED_PROJECT_STATES.has(state)) return;
  throw new ConflictException({
    code: "PROJECT_LOCKED",
    message: `This project is ${state.toLowerCase()}. Reopen it before making changes.`,
    details: { state },
  });
}

function ownsOrganization(actor: CurrentUserContext, standing: ScopedRead): boolean {
  const { principal } = actor;
  if (principal.kind !== "human-session" && principal.kind !== "personal-token") return false;
  return principal.isOrgOwner && standing.unrestricted;
}

export async function resolveProjectReach(
  access: StandingAccess,
  actor: CurrentUserContext,
): Promise<{ standing: ScopedRead; where: SQL; empty: boolean }> {
  const standing = await resolveProjectsScope(access, actor);
  const membershipId = accountableMembershipId(actor.principal);
  return {
    standing,
    where: projectReachSql(standing, actor.orgId, membershipId),
    empty: standing.denied || (!standing.unrestricted && membershipId === null),
  };
}

export async function resolveTicketVisibility(
  access: StandingAccess,
  actor: CurrentUserContext,
): Promise<SQL> {
  const [reach, ticketRead] = await Promise.all([
    resolveProjectReach(access, actor),
    resolveTicketsScope(access, actor),
  ]);
  return ticketVisibleSql(ticketRead, reach.where);
}

export async function decideProjectWrite(
  db: Db,
  orgId: string,
  projectId: number,
  reach: SQL,
): Promise<"allowed" | "missing" | "denied" | "locked"> {
  const [project] = await db
    .select({ state: projects.status, reachable: sql<boolean>`${reach}` })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) return "missing";
  if (!project.reachable) return "denied";
  return LOCKED_PROJECT_STATES.has(project.state) ? "locked" : "allowed";
}

export async function resolveProjectAccess(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<ProjectAccess> {
  const relationship = projectRelationship(u.orgId, accountableMembershipId(u.principal));
  const projectQuery = db
    .select({
      state: projects.status,
      manages: sql<boolean | null>`${relationship.manages}`,
      memberRole: relationship.memberRole,
      onTeam: sql<boolean | null>`${relationship.onTeam}`,
    })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.orgId, u.orgId),
        ...(options.includeDeleted === true ? [] : [isNull(projects.deletedAt)]),
      ),
    )
    .limit(1);
  const [standing, rows] = await Promise.all([resolveProjectsScope(access, u), projectQuery]);
  const [project] = rows;
  if (!project) throw new NotFoundException("Project not found");
  const decided = (hasAccess: boolean, role: string | null): ProjectAccess => ({
    hasAccess,
    role,
    state: project.state,
    bypassesWorkflow: ownsOrganization(u, standing),
  });
  if (standing.unrestricted) return decided(true, "OWNER");
  if (standing.denied) return decided(false, null);
  if (project.manages === true) return decided(true, "MANAGER");
  if (project.memberRole !== null) return decided(true, project.memberRole);
  if (project.onTeam === true) return decided(true, "MEMBER");
  return decided(false, null);
}

export async function assertProjectAccess(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const { hasAccess } = await resolveProjectAccess(db, access, u, projectId, options);
  if (!hasAccess) throw new ForbiddenException("You do not have access to this project");
}

export async function assertProjectWriteAccess(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess, state } = await resolveProjectAccess(db, access, u, projectId);
  if (!hasAccess) throw new ForbiddenException("You do not have access to this project");
  assertProjectStateAllowsWrites(state);
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
  access: StandingAccess,
  actor: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess } = await resolveProjectAccess(db, access, actor, projectId);
  if (!hasAccess) throw new NotFoundException("Not found");
}

export async function assertProjectVisibleForWrite(
  db: Db,
  access: StandingAccess,
  actor: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { hasAccess, state } = await resolveProjectAccess(db, access, actor, projectId);
  if (!hasAccess) throw new NotFoundException("Not found");
  assertProjectStateAllowsWrites(state);
}

export async function assertCanDeleteProject(
  access: StandingAccess,
  actor: CurrentUserContext,
): Promise<void> {
  if ((await access.scopeFor(actor, "build:delete")) === "none")
    throw new ForbiddenException("Only organization owners can delete projects");
}

export type RecordAuthor = { membershipId: number | null } | { userId: string | null };

export async function assertCanModifyAuthoredRecord(
  access: StandingAccess,
  actor: CurrentUserContext,
  author: RecordAuthor,
  managePermission: string | null,
  message: string,
): Promise<void> {
  const isAuthor =
    "membershipId" in author
      ? author.membershipId !== null && actingMembershipId(actor.principal) === author.membershipId
      : author.userId === actor.userId;
  if (isAuthor) return;
  const allowed =
    managePermission === null
      ? ownsOrganization(actor, await resolveProjectsScope(access, actor))
      : (await access.scopeFor(actor, managePermission)) !== "none";
  if (!allowed) throw new ForbiddenException(message);
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
  assertProjectStateAllowsWrites(projectAccess.state);
  const read = await resolveTicketsScope(access, actor);
  return {
    role: projectAccess.role,
    bypassesWorkflow: projectAccess.bypassesWorkflow,
    predicate: ticketInScopeSql(read),
  };
}

export type TicketChangeDecision = {
  role: string | null;
  bypassesWorkflow: boolean;
  rowScoped: boolean;
};

export async function decideTicketChange(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
): Promise<TicketChangeDecision> {
  if (systemJobCovers(actor.principal, "build:tickets:update")) {
    const [project] = await db
      .select({ state: projects.status })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");
    assertProjectStateAllowsWrites(project.state);
    return { role: "OWNER", bypassesWorkflow: false, rowScoped: false };
  }
  const projectAccess = await resolveProjectAccess(db, access, actor, projectId);
  if (!projectAccess.hasAccess) throw new ForbiddenException("Not authorized to update this ticket");
  assertProjectStateAllowsWrites(projectAccess.state);
  return { role: projectAccess.role, bypassesWorkflow: projectAccess.bypassesWorkflow, rowScoped: true };
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

export type TicketReadDecision =
  | { kind: "allowed"; projectId: number | null; projectState: ProjectState | null }
  | { kind: "missing" }
  | { kind: "denied"; reason: "NO_PROJECT_ACCESS" | "RESTRICTED_SCOPE"; projectId: number | null };

export async function decideTicketRead(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  ticketId: number,
  options: { projectId: number | null; includeDeleted?: boolean },
): Promise<TicketReadDecision> {
  const includeDeleted = options.includeDeleted === true;
  const [reach, read] = await Promise.all([
    resolveProjectReach(access, actor),
    resolveTicketsScope(access, actor),
  ]);
  const [ticket] = await db
    .select({
      projectId: tickets.projectId,
      projectState: projects.status,
      projectDeletedAt: projects.deletedAt,
      reachable: sql<boolean>`${ticketProjectReachableSql(actor.orgId, reach.where, includeDeleted)}`,
      inScope: sql<boolean>`${ticketInScopeSql(read)}`,
    })
    .from(tickets)
    .leftJoin(projects, and(eq(projects.id, tickets.projectId), eq(projects.orgId, tickets.orgId)))
    .where(
      and(
        eq(tickets.orgId, actor.orgId),
        eq(tickets.id, ticketId),
        ...(options.projectId === null ? [] : [eq(tickets.projectId, options.projectId)]),
        ...(includeDeleted ? [] : [isNull(tickets.deletedAt)]),
      ),
    )
    .limit(1);
  if (!ticket) return { kind: "missing" };
  const projectLive =
    ticket.projectId === null ||
    (ticket.projectState !== null && (includeDeleted || ticket.projectDeletedAt === null));
  if (!projectLive) return { kind: "missing" };
  if (!ticket.reachable) return { kind: "denied", reason: "NO_PROJECT_ACCESS", projectId: ticket.projectId };
  if (!ticket.inScope) return { kind: "denied", reason: "RESTRICTED_SCOPE", projectId: ticket.projectId };
  return { kind: "allowed", projectId: ticket.projectId, projectState: ticket.projectState };
}

export async function assertTicketReadAccess(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  projectId: number,
  ticketId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const decision = await decideTicketRead(db, access, actor, ticketId, { projectId, ...options });
  if (decision.kind === "missing") throw new NotFoundException("Ticket not found");
  if (decision.kind === "denied") throw new ForbiddenException("Ticket is outside your access scope");
}

export async function assertTicketWriteAccess(
  db: Db,
  access: TicketReadAccess,
  actor: CurrentUserContext,
  projectId: number,
  ticketId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<void> {
  const decision = await decideTicketRead(db, access, actor, ticketId, { projectId, ...options });
  if (decision.kind === "missing") throw new NotFoundException("Ticket not found");
  if (decision.kind === "denied") throw new ForbiddenException("Ticket is outside your access scope");
  if (decision.projectState !== null) assertProjectStateAllowsWrites(decision.projectState);
}

async function resolveProjectManagement(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
): Promise<ProjectAccess> {
  const projectAccess = await resolveProjectAccess(db, access, u, projectId);
  const { hasAccess, role } = projectAccess;
  if (!hasAccess || (role !== "OWNER" && role !== "MANAGER" && role !== "ADMIN"))
    throw new ForbiddenException("You do not have permission to manage this project");
  return projectAccess;
}

export async function assertCanManageProject(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
): Promise<void> {
  const { state } = await resolveProjectManagement(db, access, u, projectId);
  assertProjectStateAllowsWrites(state);
}

export async function authorizeProjectUpdate(
  db: Db,
  access: StandingAccess,
  u: CurrentUserContext,
  projectId: number,
  changesLifecycle: boolean,
): Promise<void> {
  const { state } = await resolveProjectManagement(db, access, u, projectId);
  if (!changesLifecycle) assertProjectStateAllowsWrites(state);
}

export async function authorizeApprovalDecision(
  db: Db,
  access: Pick<AccessService, "scopeFor" | "holds">,
  actor: CurrentUserContext,
  projectId: number,
  approverMembershipId: number | null,
): Promise<void> {
  const callerMid = actingMembershipId(actor.principal);
  const assigned = callerMid !== null && approverMembershipId === callerMid;
  if (!assigned && !(await access.holds(actor, "build:approvals:manage")))
    throw new NotFoundException("Approval not found");
  const { hasAccess, state } = await resolveProjectAccess(db, access, actor, projectId);
  if (!assigned && !hasAccess) throw new ForbiddenException("You do not have access to this project");
  assertProjectStateAllowsWrites(state);
}
