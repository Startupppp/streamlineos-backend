import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  projectTeamMembers,
  projectWorkspaceMembers,
} from "../../../db/schema/build/teams";
import { users } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { TeamsService } from "./teams.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterId } from "../../../common/pagination/keyset";
import type {
  AddTeamMemberInput,
  ListTeamMembersQuery,
  UpdateTeamMemberRoleInput,
} from "./dto/teams.schemas";

const PG_UNIQUE_VIOLATION = "23505";

@Injectable()
export class TeamMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
  ) {}

  async listTeamMembers(
    orgId: string,
    teamId: number,
    query: ListTeamMembersQuery,
  ) {
    await this.teams.loadTeam(orgId, teamId);
    const { cursor, pageSize } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(projectTeamMembers.teamId, teamId),
      eq(projectTeamMembers.orgId, orgId),
    ];
    if (pos) conds.push(keysetAfterId(projectTeamMembers.joinedAt, projectTeamMembers.id, pos));

    const rows = await this.db
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
      .where(and(...conds))
      .orderBy(asc(projectTeamMembers.joinedAt), asc(projectTeamMembers.id))
      .limit(pageSize + 1);

    return buildCursorPage(rows, pageSize, (r) => ({
      sortValue: (r.joinedAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async addMember(
    orgId: string,
    userId: string,
    teamId: number,
    input: AddTeamMemberInput,
  ) {
    await this.teams.loadTeam(orgId, teamId);

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
    await this.teams.loadTeam(orgId, teamId);
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
    await this.teams.loadTeam(orgId, teamId);
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
}
