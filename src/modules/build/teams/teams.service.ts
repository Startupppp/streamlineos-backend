import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  projectTeamMembers,
  projectTeams,
} from "../../../db/schema/build/teams";
import { organizationMembers, users } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type {
  CreateTeamInput,
  ListTeamsQuery,
  UpdateTeamInput,
} from "./dto/teams.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { escapeLike } from "../core";

export type TeamRow = typeof projectTeams.$inferSelect;
type TeamPatch = Partial<typeof projectTeams.$inferInsert>;

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async loadTeam(orgId: string, teamId: number): Promise<TeamRow> {
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

  async listTeams(
    orgId: string,
    query: ListTeamsQuery,
    _callerMembershipId: number | null,
  ) {
    const { cursor, pageSize } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(projectTeams.orgId, orgId),
      isNull(projectTeams.deletedAt),
      query.search ? ilike(projectTeams.name, `${escapeLike(query.search)}%`) : undefined,
      query.leadId !== undefined ? sql`EXISTS (
        SELECT 1 FROM ${projectTeamMembers}
        JOIN ${organizationMembers} ON ${projectTeamMembers.membershipId} = ${organizationMembers.id}
          AND ${projectTeamMembers.orgId} = ${organizationMembers.orgId}
        WHERE ${projectTeamMembers.teamId} = ${projectTeams.id}
          AND ${projectTeamMembers.orgId} = ${orgId}
          AND ${organizationMembers.userId} = ${query.leadId}
          AND ${projectTeamMembers.role} = 'lead'
      )` : undefined,
      query.memberId !== undefined ? sql`EXISTS (
        SELECT 1 FROM ${projectTeamMembers}
        JOIN ${organizationMembers} ON ${projectTeamMembers.membershipId} = ${organizationMembers.id}
          AND ${projectTeamMembers.orgId} = ${organizationMembers.orgId}
        WHERE ${projectTeamMembers.teamId} = ${projectTeams.id}
          AND ${projectTeamMembers.orgId} = ${orgId}
          AND ${organizationMembers.userId} = ${query.memberId}
      )` : undefined,
    ];
    if (pos) conds.push(keysetBeforeId(projectTeams.createdAt, projectTeams.id, pos));

    const rows = await this.db
      .select({
        id: projectTeams.id,
        orgId: projectTeams.orgId,
        name: projectTeams.name,
        key: projectTeams.key,
        icon: projectTeams.icon,
        color: projectTeams.color,
        isPrivate: projectTeams.isPrivate,
        capacity: projectTeams.capacity,
        createdAt: projectTeams.createdAt,
        updatedAt: projectTeams.updatedAt,
        memberCount: sql<number>`(
          SELECT CAST(COUNT(*) AS INT) FROM ${projectTeamMembers}
          WHERE ${projectTeamMembers.teamId} = ${projectTeams.id}
          AND ${projectTeamMembers.orgId} = ${projectTeams.orgId}
        )`,
      })
      .from(projectTeams)
      .where(and(...conds))
      .orderBy(desc(projectTeams.createdAt), desc(projectTeams.id))
      .limit(pageSize + 1);

    return buildCursorPage(rows, pageSize, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async getTeam(orgId: string, teamId: number) {
    const team = await this.loadTeam(orgId, teamId);
    const members = await this.db
      .select({
        id: projectTeamMembers.id,
        userId: organizationMembers.userId,
        role: projectTeamMembers.role,
        joinedAt: projectTeamMembers.joinedAt,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(projectTeamMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, projectTeamMembers.orgId),
          eq(organizationMembers.id, projectTeamMembers.membershipId),
        ),
      )
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(projectTeamMembers.teamId, teamId),
          eq(projectTeamMembers.orgId, orgId),
        ),
      )
      .limit(100);
    return { ...team, members };
  }

  async createTeam(
    orgId: string,
    userId: string,
    _callerMembershipId: number | null,
    input: CreateTeamInput,
  ) {
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
          capacity: input.capacity ?? null,
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
      if (isUniqueViolation(err)) {
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
    if (input.capacity !== undefined) patch.capacity = input.capacity;
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
}
