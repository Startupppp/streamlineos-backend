import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  projectStatuses,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  ticketAssignees,
  ticketLabels,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  AddMemberInput,
  CreateLabelInput,
  CreateStateInput,
  UpdateLabelInput,
  UpdateCustomStateInput,
  UpdateProjectMemberRoleInput,
} from "./dto/projects.schemas";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";

async function assertProjectOwnership(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
    columns: { id: true },
  });
  if (!project) throw new NotFoundException("Project not found");
}

function statusTypeOf(type: string | null | undefined): string {
  return type ?? "unstarted";
}

@Injectable()
export class ProjectsMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly access: AccessService,
  ) {}

  async assertCanManageProject(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<void> {
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)),
      columns: { managerId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.managerId === u.userId) return;
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
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)),
      columns: { managerId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    if (project.managerId === u.userId) return;
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

    const [orgMember] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, body.userId),
        ),
      )
      .limit(1);
    if (!orgMember) {
      throw new BadRequestException(
        "Cannot add this user to the project — they are not a member of this organization.",
      );
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
      .values({ projectId, userId: body.userId, role: body.role })
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
              SELECT id FROM tickets
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
    return this.db
      .select()
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, u.orgId),
        ),
      )
      .orderBy(projectStatuses.order);
  }

  async createCustomState(
    u: CurrentUserContext,
    projectId: number,
    body: CreateStateInput,
  ) {
    const orgId = u.orgId;
    await this.assertCanManageProject(u, projectId);

    const existing = await this.db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, orgId),
          eq(projectStatuses.name, body.name),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException(
        `A column named "${body.name}" already exists in this project`,
      );
    }

    const [maxResult] = await this.db
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${projectStatuses.order}), -1)`,
      })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, orgId),
        ),
      );
    const nextOrder = body.order ?? (maxResult?.maxOrder ?? -1) + 1;

    const [state] = await this.db
      .insert(projectStatuses)
      .values({
        projectId,
        orgId,
        name: body.name,
        color: body.color,
        order: nextOrder,
        type: body.type ?? "unstarted",
      })
      .returning();
    return state;
  }

  listLabels(orgId: string) {
    return this.db.query.ticketLabels.findMany({
      where: eq(ticketLabels.orgId, orgId),
      orderBy: [asc(ticketLabels.name)],
      limit: 300,
    });
  }

  async createLabel(orgId: string, body: CreateLabelInput) {
    const [label] = await this.db
      .insert(ticketLabels)
      .values({ orgId, name: body.name, color: body.color ?? "#3B82F6" })
      .returning();
    return label;
  }

  async updateLabel(orgId: string, labelId: number, data: UpdateLabelInput) {
    const [updated] = await this.db
      .update(ticketLabels)
      .set(data)
      .where(and(eq(ticketLabels.id, labelId), eq(ticketLabels.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Label not found");
    return updated;
  }

  async deleteLabel(orgId: string, labelId: number) {
    const [deleted] = await this.db
      .delete(ticketLabels)
      .where(and(eq(ticketLabels.id, labelId), eq(ticketLabels.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Label not found");
    return { success: true };
  }

  async updateCustomState(
    u: CurrentUserContext,
    stateId: number,
    data: UpdateCustomStateInput,
  ) {
    const orgId = u.orgId;
    const [existing] = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(eq(projectStatuses.id, stateId), eq(projectStatuses.orgId, orgId)),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Status not found");
    await this.assertCanManageProject(u, existing.projectId);

    if (data.name !== undefined && data.name !== existing.name) {
      const [duplicate] = await this.db
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(
          and(
            eq(projectStatuses.projectId, existing.projectId),
            eq(projectStatuses.orgId, orgId),
            eq(projectStatuses.name, data.name),
            ne(projectStatuses.id, stateId),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictException(
          `A column named "${data.name}" already exists in this project`,
        );
      }
    }

    const updateData: Partial<typeof projectStatuses.$inferInsert> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.color !== undefined) updateData.color = data.color;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.type !== undefined) updateData.type = data.type;

    const updated = await this.db.transaction(async (tx) => {
      if (data.name !== undefined && data.name !== existing.name) {
        await tx
          .update(tickets)
          .set({ status: data.name })
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, existing.projectId),
              eq(tickets.status, existing.name),
            ),
          );
      }

      const [row] = await tx
        .update(projectStatuses)
        .set(updateData)
        .where(
          and(
            eq(projectStatuses.id, stateId),
            eq(projectStatuses.orgId, orgId),
          ),
        )
        .returning();
      return row;
    });

    if (!updated) throw new NotFoundException("Status not found");
    return updated;
  }

  async deleteCustomState(u: CurrentUserContext, stateId: number) {
    const orgId = u.orgId;
    const [existing] = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(eq(projectStatuses.id, stateId), eq(projectStatuses.orgId, orgId)),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Status not found");
    await this.assertCanManageProject(u, existing.projectId);

    const siblings = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, existing.projectId),
          eq(projectStatuses.orgId, orgId),
        ),
      )
      .orderBy(projectStatuses.order);

    const remaining = siblings.filter((s) => s.id !== stateId);
    if (remaining.length === 0) {
      throw new BadRequestException("At least one workflow status is required");
    }

    const existingType = statusTypeOf(existing.type);
    if (
      existingType === "unstarted" &&
      !remaining.some((s) => statusTypeOf(s.type) === "unstarted")
    ) {
      throw new BadRequestException("Keep at least one Unstarted status");
    }
    if (
      existingType === "completed" &&
      !remaining.some((s) => statusTypeOf(s.type) === "completed")
    ) {
      throw new BadRequestException("Keep at least one Completed status");
    }

    const fallback =
      remaining.find((s) => statusTypeOf(s.type) === "unstarted") ??
      remaining[0];
    if (!fallback) {
      throw new BadRequestException("At least one workflow status is required");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ status: fallback.name })
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, existing.projectId),
            eq(tickets.status, existing.name),
          ),
        );

      await tx
        .delete(projectStatuses)
        .where(
          and(
            eq(projectStatuses.id, stateId),
            eq(projectStatuses.orgId, orgId),
          ),
        );
    });

    return { success: true };
  }
}
