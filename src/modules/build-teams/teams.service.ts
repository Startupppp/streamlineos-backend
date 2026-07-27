import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  projectWorkspaceMembers,
} from "../../db/schema/build/teams";
import { projects } from "../../db/schema/build/core";
import { users } from "../../db/schema/common/auth";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  AddTeamMemberInput,
  CreateTeamInput,
  ListTeamMembersQuery,
  ListTeamsQuery,
  UpdateTeamInput,
  UpdateTeamMemberRoleInput,
} from "./dto/teams.schemas";

const PG_UNIQUE_VIOLATION = "23505";

type TeamRow = typeof projectTeams.$inferSelect;
type TeamPatch = Partial<typeof projectTeams.$inferInsert>;

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadTeam(orgId: string, teamId: number): Promise<TeamRow> {
    const [row] = await this.db
      .select()
      .from(projectTeams)
      .where(
        and(
          eq(projectTeams.id, teamId),
          eq(projectTeams.orgId, orgId),
          isNull(projectTeams.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Team not found");
    return row;
  }

  async listTeams(orgId: string, query: ListTeamsQuery) {
    const offset = (query.page - 1) * query.pageSize;
    const baseWhere = and(
      eq(projectTeams.orgId, orgId),
      isNull(projectTeams.deletedAt),
      query.search ? ilike(projectTeams.name, `%${query.search}%`) : undefined,
    );

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: projectTeams.id,
          orgId: projectTeams.orgId,
          name: projectTeams.name,
          key: projectTeams.key,
          icon: projectTeams.icon,
          color: projectTeams.color,
          isPrivate: projectTeams.isPrivate,
          createdAt: projectTeams.createdAt,
          updatedAt: projectTeams.updatedAt,
          memberCount: sql<number>`(
            SELECT CAST(COUNT(*) AS INT) FROM ${projectTeamMembers}
            WHERE ${projectTeamMembers.teamId} = ${projectTeams.id}
          )`,
        })
        .from(projectTeams)
        .where(baseWhere)
        .limit(query.pageSize)
        .offset(offset),
      this.db.select({ total: count() }).from(projectTeams).where(baseWhere),
    ]);

    return {
      data: rows,
      total: Number(countRow?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getTeam(orgId: string, teamId: number) {
    const team = await this.loadTeam(orgId, teamId);
    const members = await this.db
      .select({
        id: projectTeamMembers.id,
        userId: projectTeamMembers.userId,
        role: projectTeamMembers.role,
        joinedAt: projectTeamMembers.joinedAt,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(projectTeamMembers)
      .innerJoin(users, eq(users.id, projectTeamMembers.userId))
      .where(
        and(
          eq(projectTeamMembers.teamId, teamId),
          eq(projectTeamMembers.orgId, orgId),
        ),
      )
      .limit(100);
    return { ...team, members };
  }

  async createTeam(orgId: string, userId: string, input: CreateTeamInput) {
    try {
      const [row] = await this.db
        .insert(projectTeams)
        .values({
          orgId,
          name: input.name,
          key: input.key,
          icon: input.icon ?? null,
          color: input.color ?? null,
          isPrivate: input.isPrivate ?? false,
        })
        .returning();
      if (!row) throw new NotFoundException("Failed to create team");
      this.audit.log({
        action: "project_team.created",
        userId,
        orgId,
        resourceType: "project_team",
        resourceId: String(row.id),
        metadata: { teamId: row.id, name: row.name, key: row.key },
      });
      return row;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          `A team with key "${input.key}" already exists in this organisation.`,
        );
      }
      throw err;
    }
  }

  async updateTeam(
    orgId: string,
    userId: string,
    teamId: number,
    input: UpdateTeamInput,
  ) {
    await this.loadTeam(orgId, teamId);
    const patch: TeamPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.icon !== undefined) patch.icon = input.icon ?? null;
    if (input.color !== undefined) patch.color = input.color ?? null;
    if (input.isPrivate !== undefined) patch.isPrivate = input.isPrivate;
    const [updated] = await this.db
      .update(projectTeams)
      .set(patch)
      .where(and(eq(projectTeams.id, teamId), eq(projectTeams.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Team not found");
    this.audit.log({
      action: "project_team.updated",
      userId,
      orgId,
      resourceType: "project_team",
      resourceId: String(teamId),
      metadata: { teamId },
    });
    return updated;
  }

  async deleteTeam(orgId: string, userId: string, teamId: number) {
    await this.loadTeam(orgId, teamId);
    await this.db
      .update(projectTeams)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectTeams.id, teamId), eq(projectTeams.orgId, orgId)));
    this.audit.log({
      action: "project_team.deleted",
      userId,
      orgId,
      resourceType: "project_team",
      resourceId: String(teamId),
      metadata: { teamId },
    });
  }

  async listTeamMembers(
    orgId: string,
    teamId: number,
    query: ListTeamMembersQuery,
  ) {
    await this.loadTeam(orgId, teamId);
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: projectTeamMembers.id,
          userId: projectTeamMembers.userId,
          role: projectTeamMembers.role,
          joinedAt: projectTeamMembers.joinedAt,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          image: users.image,
        })
        .from(projectTeamMembers)
        .innerJoin(users, eq(users.id, projectTeamMembers.userId))
        .where(
          and(
            eq(projectTeamMembers.teamId, teamId),
            eq(projectTeamMembers.orgId, orgId),
          ),
        )
        .limit(query.pageSize)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(projectTeamMembers)
        .where(
          and(
            eq(projectTeamMembers.teamId, teamId),
            eq(projectTeamMembers.orgId, orgId),
          ),
        ),
    ]);
    return {
      data: rows,
      total: Number(countRow?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async addMember(
    orgId: string,
    userId: string,
    teamId: number,
    input: AddTeamMemberInput,
  ) {
    await this.loadTeam(orgId, teamId);

    const [workspaceMember] = await this.db
      .select({ id: projectWorkspaceMembers.id })
      .from(projectWorkspaceMembers)
      .where(
        and(
          eq(projectWorkspaceMembers.orgId, orgId),
          eq(projectWorkspaceMembers.userId, input.userId),
        ),
      )
      .limit(1);
    if (!workspaceMember) {
      throw new BadRequestException(
        "Only Projects workspace members can be added to a team. Add this person to the workspace on the Members page first.",
      );
    }

    try {
      const [row] = await this.db
        .insert(projectTeamMembers)
        .values({
          orgId,
          teamId,
          userId: input.userId,
          role: input.role ?? "member",
        })
        .returning();
      this.audit.log({
        action: "project_team.member_added",
        userId,
        orgId,
        resourceType: "project_team",
        resourceId: String(teamId),
        metadata: { teamId, memberId: input.userId },
      });
      return row;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException("User is already a member of this team.");
      }
      throw err;
    }
  }

  async removeMember(
    orgId: string,
    userId: string,
    teamId: number,
    memberId: string,
  ) {
    await this.loadTeam(orgId, teamId);
    await this.db
      .delete(projectTeamMembers)
      .where(
        and(
          eq(projectTeamMembers.teamId, teamId),
          eq(projectTeamMembers.userId, memberId),
          eq(projectTeamMembers.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "project_team.member_removed",
      userId,
      orgId,
      resourceType: "project_team",
      resourceId: String(teamId),
      metadata: { teamId, memberId },
    });
  }

  async updateMemberRole(
    orgId: string,
    actorId: string,
    teamId: number,
    memberUserId: string,
    input: UpdateTeamMemberRoleInput,
  ) {
    await this.loadTeam(orgId, teamId);
    const [updated] = await this.db
      .update(projectTeamMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(projectTeamMembers.teamId, teamId),
          eq(projectTeamMembers.userId, memberUserId),
          eq(projectTeamMembers.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Team member not found");
    this.audit.log({
      action: "project_team.member_role_updated",
      userId: actorId,
      orgId,
      resourceType: "project_team",
      resourceId: String(teamId),
      metadata: { teamId, memberId: memberUserId, role: input.role },
    });
    return updated;
  }

  async listTeamProjects(orgId: string, teamId: number) {
    await this.loadTeam(orgId, teamId);
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        addedAt: projectTeamAssignments.addedAt,
      })
      .from(projectTeamAssignments)
      .innerJoin(projects, eq(projects.id, projectTeamAssignments.projectId))
      .where(
        and(
          eq(projectTeamAssignments.teamId, teamId),
          eq(projectTeamAssignments.orgId, orgId),
        ),
      )
      .orderBy(desc(projectTeamAssignments.addedAt))
      .limit(200);
  }

  async addProject(
    orgId: string,
    actorId: string,
    teamId: number,
    projectId: number,
  ) {
    await this.loadTeam(orgId, teamId);
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    try {
      const [row] = await this.db
        .insert(projectTeamAssignments)
        .values({ orgId, teamId, projectId })
        .returning();
      this.audit.log({
        action: "project_team.project_added",
        userId: actorId,
        orgId,
        resourceType: "project_team",
        resourceId: String(teamId),
        metadata: { teamId, projectId },
      });
      return row;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          "This project is already assigned to the team.",
        );
      }
      throw err;
    }
  }

  async removeProject(
    orgId: string,
    actorId: string,
    teamId: number,
    projectId: number,
  ) {
    await this.loadTeam(orgId, teamId);
    await this.db
      .delete(projectTeamAssignments)
      .where(
        and(
          eq(projectTeamAssignments.teamId, teamId),
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "project_team.project_removed",
      userId: actorId,
      orgId,
      resourceType: "project_team",
      resourceId: String(teamId),
      metadata: { teamId, projectId },
    });
  }
}
