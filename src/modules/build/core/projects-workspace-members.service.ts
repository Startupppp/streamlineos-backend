import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, asc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import {
  organizationMembers,
  projectTeamMembers,
  projectTeams,
  projectWorkspaceMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";
import { keysetAfter } from "../../../common/pagination/keyset";
import type {
  AddWorkspaceMemberInput,
  ListWorkspaceMembersInput,
} from "./dto/projects-workspace-members.schemas";

const PG_UNIQUE_VIOLATION = "23505";

@Injectable()
export class ProjectsWorkspaceMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly pmWorkspaces: PmWorkspacesService,
  ) {}

  async list(orgId: string, query: ListWorkspaceMembersInput) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const search = query.search?.trim();
    const searchCond = search
      ? or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
        )
      : undefined;
    const conds = [eq(projectWorkspaceMembers.orgId, orgId), searchCond];
    if (pos) conds.push(keysetAfter(projectWorkspaceMembers.addedAt, organizationMembers.userId, pos));

    const rows = await this.db
      .select({
        id: organizationMembers.userId,
        role: projectWorkspaceMembers.role,
        addedAt: projectWorkspaceMembers.addedAt,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        image: users.image,
      })
      .from(projectWorkspaceMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectWorkspaceMembers.orgId), eq(organizationMembers.id, projectWorkspaceMembers.membershipId)))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(...conds))
      .orderBy(asc(projectWorkspaceMembers.addedAt), asc(organizationMembers.userId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const userIds = pageRows.map((r) => r.id);
    const teamRows = userIds.length
      ? await this.db
          .select({
            userId: organizationMembers.userId,
            teamName: projectTeams.name,
          })
          .from(projectTeamMembers)
          .innerJoin(
            projectTeams,
            and(
              eq(projectTeams.id, projectTeamMembers.teamId),
              isNull(projectTeams.deletedAt),
            ),
          )
          .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectTeamMembers.orgId), eq(organizationMembers.id, projectTeamMembers.membershipId)))
          .where(
            and(
              eq(projectTeamMembers.orgId, orgId),
              inArray(organizationMembers.userId, userIds),
            ),
          )
      : [];

    const teamsByUser = new Map<string, string[]>();
    for (const t of teamRows) {
      const arr = teamsByUser.get(t.userId) ?? [];
      if (!arr.includes(t.teamName)) arr.push(t.teamName);
      teamsByUser.set(t.userId, arr);
    }

    const data = pageRows.map((r) => ({ ...r, teams: teamsByUser.get(r.id) ?? [] }));
    const last = data[data.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ sortValue: (last.addedAt ?? new Date(0)).toISOString(), id: last.id })
      : null;

    return {
      data,
      pagination: { limit, hasMore, nextCursor },
    };
  }

  async add(orgId: string, actorId: string, input: AddWorkspaceMemberInput) {
    const [orgMember] = await this.db
      .select({ id: organizationMembers.id, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, input.userId),
        ),
      )
      .limit(1);
    if (!orgMember) {
      throw new BadRequestException(
        "This user is not a member of the organization.",
      );
    }

    try {
      const pmWorkspaceId = await this.pmWorkspaces.resolveDefaultWorkspaceId(orgId);
      const [row] = await this.db
        .insert(projectWorkspaceMembers)
        .values({ orgId, pmWorkspaceId, membershipId: orgMember.id, role: input.role })
        .returning();
      this.audit.log({
        action: "project_workspace.member_added",
        userId: actorId,
        orgId,
        resourceType: "project_workspace_member",
        resourceId: input.userId,
        metadata: { role: input.role },
      });
      return row;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException("This user is already a workspace member.");
      }
      throw err;
    }
  }

  async remove(orgId: string, actorId: string, userId: string) {
    const [orgMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!orgMember) return;
    await this.db.transaction(async (tx) => {
      await tx
        .delete(projectWorkspaceMembers)
        .where(
          and(
            eq(projectWorkspaceMembers.orgId, orgId),
            eq(projectWorkspaceMembers.membershipId, orgMember.id),
          ),
        );
      await tx
        .delete(projectTeamMembers)
        .where(
          and(
            eq(projectTeamMembers.orgId, orgId),
            eq(projectTeamMembers.membershipId, orgMember.id),
          ),
        );
    });
    this.audit.log({
      action: "project_workspace.member_removed",
      userId: actorId,
      orgId,
      resourceType: "project_workspace_member",
      resourceId: userId,
    });
  }

  async isWorkspaceMember(orgId: string, userId: string): Promise<boolean> {
    const [orgMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!orgMember) return false;
    const [row] = await this.db
      .select({ id: projectWorkspaceMembers.id })
      .from(projectWorkspaceMembers)
      .where(
        and(
          eq(projectWorkspaceMembers.orgId, orgId),
          eq(projectWorkspaceMembers.membershipId, orgMember.id),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}
