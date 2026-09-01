import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  ticketAssignees,
  tickets,
  users,
} from "../../../db/schema";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import type { OrganizationActor } from "../../../common/organization/organization-actor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type {
  AddMemberInput,
  CreateLabelInput,
  CreateStateInput,
  UpdateLabelInput,
  UpdateCustomStateInput,
  UpdateProjectMemberRoleInput,
} from "./dto/projects.schemas";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import { ProjectsLabelsService } from "./projects-labels.service";

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
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { managerId: true, managerMembershipId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const callerMid = actingMembershipId(u.principal);
    if ((callerMid !== null && project.managerMembershipId === callerMid) || project.managerId === u.userId) return;
    const membership = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, u.userId),
        ),
      )
      .limit(1);
    if (membership[0]?.role === "ADMIN") return;
    throw new ForbiddenException(
      "You do not have permission to manage this project",
    );
  }

  async assertProjectAccess(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<void> {
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { managerId: true, managerMembershipId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const callerMid = actingMembershipId(u.principal);
    if ((callerMid !== null && project.managerMembershipId === callerMid) || project.managerId === u.userId) return;
    const membership = await this.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, u.userId),
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
          eq(projectTeamMembers.userId, u.userId),
        ),
      )
      .limit(1);
    if (teamAccess.length > 0) return;

    throw new ForbiddenException("You do not have access to this project");
  }

  async listMembers(u: CurrentUserContext, projectId: number) {
    await this.assertProjectAccess(u, projectId);
    return this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        email: users.email,
        role: projectMembers.role,
        joinedAt: projectMembers.joinedAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .innerJoin(
        projects,
        and(
          eq(projects.id, projectMembers.projectId),
          eq(projects.orgId, u.orgId),
        ),
      )
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(asc(projectMembers.joinedAt))
      .limit(100);
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
      .innerJoin(users, eq(users.id, projectTeamMembers.userId))
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
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, body.userId),
      ),
    });
    if (existing)
      throw new ConflictException("User is already a project member");

    const [member] = await this.db
      .insert(projectMembers)
      .values({ orgId, projectId, userId: body.userId, membershipId: actor.membershipId, role: body.role })
      .returning();

    this.webhooksDispatch.dispatch(orgId, projectId, "member.added", {
      id: member.id,
      projectId,
      userId: body.userId,
      role: body.role,
      actor: actorId,
      timestamp: new Date().toISOString(),
    });

    return member;
  }

  async removeMember(projectId: number, userId: string, u: CurrentUserContext) {
    const orgId = u.orgId;
    const actorId = u.userId;
    await assertProjectOwnership(this.db, orgId, projectId);
    await this.assertCanManageProject(u, projectId);

    await this.db.transaction(async (tx) => {
      await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        );

      await tx
        .update(tickets)
        .set({ assigneeId: null })
        .where(
          and(
            eq(tickets.projectId, projectId),
            eq(tickets.orgId, orgId),
            eq(tickets.assigneeId, userId),
            ne(tickets.status, "DONE"),
            ne(tickets.status, "CANCELLED"),
          ),
        );

      await tx.delete(ticketAssignees).where(
        and(
          eq(ticketAssignees.userId, userId),
          sql`${ticketAssignees.ticketId} IN (
              SELECT id FROM build.tickets
              WHERE project_id = ${projectId}
              AND org_id = ${orgId}
              AND status NOT IN ('DONE', 'CANCELLED')
            )`,
        ),
      );
    });

    this.webhooksDispatch.dispatch(orgId, projectId, "member.removed", {
      id: projectId,
      projectId,
      userId,
      actor: actorId,
      timestamp: new Date().toISOString(),
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

    const [updated] = await this.db
      .update(projectMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, memberUserId),
        ),
      )
      .returning({
        id: projectMembers.id,
        userId: projectMembers.userId,
        role: projectMembers.role,
      });

    if (!updated) throw new NotFoundException("Member not found");

    this.webhooksDispatch.dispatch(orgId, projectId, "member.role_updated", {
      id: updated.id,
      projectId,
      userId: memberUserId,
      role: input.role,
      actor: actorId,
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  async listCustomStates(u: CurrentUserContext, projectId: number) {
    await this.assertProjectAccess(u, projectId);
    return this.statesService.listCustomStates(u.orgId, projectId);
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
    stateId: number,
    data: UpdateCustomStateInput,
  ) {
    return this.statesService.updateCustomState(u, stateId, data);
  }

  deleteCustomState(u: CurrentUserContext, stateId: number) {
    return this.statesService.deleteCustomState(u, stateId);
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
