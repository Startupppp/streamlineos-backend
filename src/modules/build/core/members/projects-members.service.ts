import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../../common/pagination/cursor";
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
import { ProjectsLabelsService } from "../lib/projects-labels.service";
import { escapeLike } from "../lib/escape-like";
import { assertProjectAccess, assertCanManageProject, resolveProjectReach } from "../project-crud/project-access";

@Injectable()
export class ProjectsMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly access: AccessService,
    private readonly statesService: ProjectsCustomStatesService,
    private readonly labelsService: ProjectsLabelsService,
  ) {}

  async listMembers(
    u: CurrentUserContext,
    projectId: number,
    query: ListProjectMembersQuery = { limit: 25 },
  ) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { limit, cursor, search } = query;
    const pos = decodeCursor(cursor);
    const conds: SQL[] = [
      eq(projectMembers.orgId, u.orgId),
      eq(projectMembers.projectId, projectId),
      isNull(projects.deletedAt),
    ];
    if (search) {
      const like = `%${escapeLike(search)}%`;
      const searchCondition = or(
        ilike(users.name, like),
        ilike(users.email, like),
        ilike(users.firstName, like),
        ilike(users.lastName, like),
        ilike(sql`${projectMembers.role}::text`, like),
      );
      if (searchCondition) conds.push(searchCondition);
    }
    if (pos)
      conds.push(
        keysetAfterId(
          projectMembers.joinedAt,
          projectMembers.membershipId,
          pos,
        ),
      );

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
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.id, projectMembers.membershipId),
        ),
      )
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
    await assertProjectAccess(this.db, this.access, u, projectId);

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
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.id, projectTeamMembers.membershipId),
        ),
      )
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
    await assertCanManageProject(this.db, this.access, u, projectId);

    let actor: OrganizationActor;
    try {
      actor = await assertOrganizationActor(this.db, orgId, {
        kind: "user",
        userId: body.userId,
      });
    } catch (e) {
      if (e instanceof OrganizationActorError)
        throw organizationActorHttpError(e);
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
        .values({
          orgId,
          projectId,
          membershipId: actor.membershipId,
          role: body.role,
        })
        .returning();
      await this.webhooksDispatch.enqueue(
        tx,
        orgId,
        projectId,
        "member.added",
        {
          id: created.id,
          projectId,
          userId: body.userId,
          role: body.role,
          actor: actorId,
          timestamp: new Date().toISOString(),
        },
      );
      return created;
    });

    return member;
  }

  async removeMember(projectId: number, userId: string, u: CurrentUserContext) {
    const orgId = u.orgId;
    const actorId = u.userId;
    await assertCanManageProject(this.db, this.access, u, projectId);
    const targetActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId,
    });

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
      await this.webhooksDispatch.enqueue(
        tx,
        orgId,
        projectId,
        "member.removed",
        {
          id: projectId,
          projectId,
          userId,
          actor: actorId,
          timestamp: new Date().toISOString(),
        },
      );
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
    await assertCanManageProject(this.db, this.access, u, projectId);
    const targetActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId: memberUserId,
    });

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(projectMembers)
        .set({ role: input.role })
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.membershipId, targetActor.membershipId),
          ),
        )
        .returning({
          id: projectMembers.id,
          membershipId: projectMembers.membershipId,
          role: projectMembers.role,
        });
      if (!row) throw new NotFoundException("Member not found");
      await this.webhooksDispatch.enqueue(
        tx,
        orgId,
        projectId,
        "member.role_updated",
        {
          id: row.id,
          projectId,
          userId: memberUserId,
          role: input.role,
          actor: actorId,
          timestamp: new Date().toISOString(),
        },
      );
      return { ...row, userId: memberUserId };
    });

    return updated;
  }

  async listCustomStates(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.statesService.listCustomStates(u.orgId, projectId);
  }

  async listOrgCustomStates(u: CurrentUserContext) {
    const reach = await resolveProjectReach(this.access, u);
    return this.statesService.listOrgCustomStates(u.orgId, reach.where);
  }

  async createCustomState(
    u: CurrentUserContext,
    projectId: number,
    body: CreateStateInput,
  ) {
    await assertCanManageProject(this.db, this.access, u, projectId);
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

  async listProjectLabels(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.labelsService.listLabels(u.orgId);
  }

  createLabel(orgId: string, body: CreateLabelInput) {
    return this.labelsService.createLabel(orgId, body);
  }

  async createProjectLabel(u: CurrentUserContext, projectId: number, body: CreateLabelInput) {
    await assertCanManageProject(this.db, this.access, u, projectId);
    return this.labelsService.createLabel(u.orgId, body);
  }

  updateLabel(orgId: string, labelId: number, data: UpdateLabelInput) {
    return this.labelsService.updateLabel(orgId, labelId, data);
  }

  deleteLabel(orgId: string, labelId: number) {
    return this.labelsService.deleteLabel(orgId, labelId);
  }
}
