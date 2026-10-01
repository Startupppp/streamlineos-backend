import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { projectTeamAssignments } from "../../../db/schema/build/teams";
import { projects } from "../../../db/schema/build/core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { TeamsService } from "./teams.service";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertCanManageProject } from "../core";

@Injectable()
export class TeamProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async listTeamProjects(orgId: string, teamId: number) {
    await this.teams.loadTeam(orgId, teamId);
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
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(projectTeamAssignments.addedAt))
      .limit(200);
  }

  async addProject(actor: CurrentUserContext, teamId: number, projectId: number) {
    const { orgId, userId: actorId } = actor;
    await this.teams.loadTeam(orgId, teamId);
    await assertCanManageProject(this.db, this.access, actor, projectId);

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
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "This project is already assigned to the team.",
        );
      }
      throw err;
    }
  }

  async removeProject(actor: CurrentUserContext, teamId: number, projectId: number) {
    const { orgId, userId: actorId } = actor;
    await this.teams.loadTeam(orgId, teamId);
    await assertCanManageProject(this.db, this.access, actor, projectId);
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
