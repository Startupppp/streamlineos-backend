import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import { keysetAfterId } from "../../../../common/pagination/keyset";
import type { ListProjectMembersQuery } from "../dto/projects.schemas";
import {
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  ticketAssignees,
  tickets,
  organizationMembers,
  users,
} from "../../../../db/schema";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../../common/organization/organization-actor";
import type { OrganizationActor } from "../../../../common/organization/organization-actor";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import type {
  AddMemberInput,
  BulkReorderStatesInput,
  CreateLabelInput,
  CreateStateInput,
  UpdateLabelInput,
  UpdateCustomStateInput,
  UpdateProjectMemberRoleInput,
} from "../dto/projects.schemas";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { ProjectsCustomStatesService } from "../custom-states/projects-custom-states.service";
import { ProjectsLabelsService } from "../tickets/projects-labels.service";

async function assertProjectOwnership(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
    columns: { id: true },
  });
  if (!project) throw new NotFoundException("Project not found");
}

@Injectable()
export class ProjectsMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly access: AccessService,
    private readonly statesService: ProjectsCustomStatesService,
    private readonly labelsService: ProjectsLabelsService,
  ) {}

  async assertCanManageProject(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<void> {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { managerMembershipId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const callerMid = actingMembershipId(u.principal);
    if (callerMid !== null && project.managerMembershipId === callerMid) return;
    const membership = await this.db
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
    if (membership[0]?.role === "ADMIN") return;
    throw new ForbiddenException(
      "You do not have permission to manage this project",
    );
  }

  /**
   * The project is resolved under the caller's organisation BEFORE any short-circuit.
   *
   * The two rungs above used to return first: an org owner, and anyone holding `build:manage`,
   * passed this check for a project id that belongs to another organisation and for one that
   * belongs to nobody. Nothing crossed — every read below still filters on `u.orgId` — but the
   * handler then answered 200 with the caller's own (empty) rows where the contract requires 404,
   * so five routes could not tell a project that does not exist from one they may not see:
   * `GET /build/:projectId/automations`, `/custom-states`, `/labels`, `/members` and `/roster`.
   * `assertCanManageProject`, twenty lines above, already does the lookup first; this is the same
   * order, and the standing checks below it are unchanged.
   */
  async assertProjectAccess(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<void> {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { managerMembershipId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const callerMid = actingMembershipId(u.principal);
    if (callerMid !== null && project.managerMembershipId === callerMid) return;
    const membership = await this.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.orgId, u.orgId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.membershipId, callerMid ?? -1),
        ),
      )
      .limit(1);
    if (membership.length > 0) return;

    const teamAccess = await this.db
      .select({ id: projectTeamMembers.id })
      .from(projectTeamAssignments)
      .innerJoin(
        projectTeamMembers,
        eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
      )
      .where(
        and(
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, u.orgId),
          eq(projectTeamMembers.membershipId, callerMid ?? -1),
        ),
      )
      .limit(1);
    if (teamAccess.length > 0) return;

    throw new ForbiddenException("You do not have access to this project");
  }

  async listMembers(u: CurrentUserContext, projectId: number, query: ListProjectMembersQuery = { limit: 25 }) {
    await this.assertProjectAccess(u, projectId);
    const { limit, cursor } = query;
    const pos = decodeCursor(cursor);
    const conds: SQL[] = [eq(projectMembers.projectId, projectId)];
    if (pos) {
      conds.push(keysetAfterId(projectMembers.joinedAt, projectMembers.membershipId, pos));
    }
    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        email: users.email,
        role: projectMembers.role,
        joinedAt: projectMembers.joinedAt,
        membershipId: projectMembers.membershipId,
      })
      .from(projectMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .innerJoin(
        projects,
        and(
          eq(projects.id, projectMembers.projectId),
          eq(projects.orgId, u.orgId),
        ),
      )
      .where(and(...conds))
      .orderBy(asc(projectMembers.joinedAt), asc(projectMembers.membershipId))
      .limit(limit + 1);
    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.joinedAt.toISOString(),
      id: String(row.membershipId),
    }));
    return {
      ...page,
      data: page.data.map(({ membershipId: _mid, ...rest }) => rest),
    };
  }

  async getProjectRoster(u: CurrentUserContext, projectId: number) {
    await this.assertProjectAccess(u, projectId);

    const assignments = await this.db
      .select({
        teamId: projectTeamAssignments.teamId,
        teamName: projectTeams.name,
        teamKey: projectTeams.key,
      })
      .from(projectTeamAssignments)
      .innerJoin(
        projectTeams,
        and(
          eq(projectTeams.id, projectTeamAssignments.teamId),
          isNull(projectTeams.deletedAt),
        ),
      )
      .where(
        and(
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, u.orgId),
        ),
      );

    if (assignments.length === 0) {
      return { teams: [], members: [] };
    }

    const teamIds = assignments.map((a) => a.teamId);

    const memberRows = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(projectTeamMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.id, projectTeamMembers.membershipId)))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(projectTeamMembers.orgId, u.orgId),
          inArray(projectTeamMembers.teamId, teamIds),
        ),
      )
      .orderBy(asc(users.firstName))
      .limit(500);

    const membersById = new Map<string, (typeof memberRows)[number]>();
    for (const m of memberRows) {
      if (!membersById.has(m.id)) membersById.set(m.id, m);
    }

    return {
      teams: assignments.map((a) => ({
        id: a.teamId,
        name: a.teamName,
        key: a.teamKey,
      })),
      members: [...membersById.values()],
    };
  }

  async addMember(
    projectId: number,
    body: AddMemberInput,
    u: CurrentUserContext,
  ) {
    const orgId = u.orgId;
    const actorId = u.userId;
    await assertProjectOwnership(this.db, orgId, projectId);
    await this.assertCanManageProject(u, projectId);

    let actor: OrganizationActor;
    try {
      actor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId: body.userId });
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const existing = await this.db.query.projectMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(projectMembers.orgId, orgId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.membershipId, actor.membershipId),
      ),
    });
    if (existing)
      throw new ConflictException("User is already a project member");

    const member = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projectMembers)
        .values({ orgId, projectId, membershipId: actor.membershipId, role: body.role })
        .returning();
      await this.webhooksDispatch.enqueue(tx, orgId, projectId, "member.added", {
        id: created.id,
        projectId,
        userId: body.userId,
        role: body.role,
        actor: actorId,
        timestamp: new Date().toISOString(),
      });
      return created;
    });

    return member;
  }

  async removeMember(projectId: number, userId: string, u: CurrentUserContext) {
    const orgId = u.orgId;
    const actorId = u.userId;
    await assertProjectOwnership(this.db, orgId, projectId);
    await this.assertCanManageProject(u, projectId);
    const targetActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId });

    await this.db.transaction(async (tx) => {
      await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.membershipId, targetActor.membershipId),
          ),
        );

      await tx
        .update(tickets)
        .set({ assigneeMembershipId: null })
        .where(
          and(
            eq(tickets.projectId, projectId),
            eq(tickets.orgId, orgId),
            eq(tickets.assigneeMembershipId, targetActor.membershipId),
            ne(tickets.status, "DONE"),
            ne(tickets.status, "CANCELLED"),
          ),
        );

      await tx.delete(ticketAssignees).where(
        and(
          eq(ticketAssignees.membershipId, targetActor.membershipId),
          sql`${ticketAssignees.ticketId} IN (
              SELECT id FROM build.tickets
              WHERE project_id = ${projectId}
              AND org_id = ${orgId}
              AND status NOT IN ('DONE', 'CANCELLED')
            )`,
        ),
      );
      await this.webhooksDispatch.enqueue(tx, orgId, projectId, "member.removed", {
        id: projectId,
        projectId,
        userId,
        actor: actorId,
        timestamp: new Date().toISOString(),
      });
    });

    return { success: true };
  }

  async updateMemberRole(
    projectId: number,
    memberUserId: string,
    input: UpdateProjectMemberRoleInput,
    u: CurrentUserContext,
  ) {
    const orgId = u.orgId;
    const actorId = u.userId;
    await assertProjectOwnership(this.db, orgId, projectId);
    await this.assertCanManageProject(u, projectId);
    const targetActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId: memberUserId });

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(projectMembers)
        .set({ role: input.role })
        .where(and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.membershipId, targetActor.membershipId),
        ))
        .returning({
          id: projectMembers.id,
          membershipId: projectMembers.membershipId,
          role: projectMembers.role,
        });
      if (!row) throw new NotFoundException("Member not found");
      await this.webhooksDispatch.enqueue(tx, orgId, projectId, "member.role_updated", {
        id: row.id,
        projectId,
        userId: memberUserId,
        role: input.role,
        actor: actorId,
        timestamp: new Date().toISOString(),
      });
      return { ...row, userId: memberUserId };
    });

    return updated;
  }

  async listCustomStates(u: CurrentUserContext, projectId: number) {
    await this.assertProjectAccess(u, projectId);
    return this.statesService.listCustomStates(u.orgId, projectId);
  }

  listOrgCustomStates(u: CurrentUserContext) {
    return this.statesService.listOrgCustomStates(u.orgId);
  }

  async createCustomState(
    u: CurrentUserContext,
    projectId: number,
    body: CreateStateInput,
  ) {
    await this.assertCanManageProject(u, projectId);
    return this.statesService.createCustomState(u.orgId, projectId, body);
  }

  updateCustomState(
    u: CurrentUserContext,
    projectId: number,
    stateId: number,
    data: UpdateCustomStateInput,
  ) {
    return this.statesService.updateCustomState(u, projectId, stateId, data);
  }

  deleteCustomState(u: CurrentUserContext, projectId: number, stateId: number) {
    return this.statesService.deleteCustomState(u, projectId, stateId);
  }

  bulkReorderCustomStates(
    u: CurrentUserContext,
    projectId: number,
    body: BulkReorderStatesInput,
  ) {
    return this.statesService.bulkReorderCustomStates(u, projectId, body);
  }

  listLabels(orgId: string) {
    return this.labelsService.listLabels(orgId);
  }

  createLabel(orgId: string, body: CreateLabelInput) {
    return this.labelsService.createLabel(orgId, body);
  }

  updateLabel(orgId: string, labelId: number, data: UpdateLabelInput) {
    return this.labelsService.updateLabel(orgId, labelId, data);
  }

  deleteLabel(orgId: string, labelId: number) {
    return this.labelsService.deleteLabel(orgId, labelId);
  }
}
