import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, asc, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import {
  organizationMembers,
  projectTeamMembers,
  projectTeams,
  projectWorkspaceMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
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
  ) {}

  async list(orgId: string, query: ListWorkspaceMembersInput) {
    const offset = (query.page - 1) * query.limit;
    const search = query.search?.trim();
    const searchCond = search
      ? or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
        )
      : undefined;
    const where = and(eq(projectWorkspaceMembers.orgId, orgId), searchCond);

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: projectWorkspaceMembers.userId,
          role: projectWorkspaceMembers.role,
          addedAt: projectWorkspaceMembers.addedAt,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          image: users.image,
        })
        .from(projectWorkspaceMembers)
        .innerJoin(users, eq(users.id, projectWorkspaceMembers.userId))
        .where(where)
        .orderBy(asc(projectWorkspaceMembers.addedAt))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(projectWorkspaceMembers)
        .innerJoin(users, eq(users.id, projectWorkspaceMembers.userId))
        .where(where),
    ]);

    const userIds = rows.map((r) => r.id);
    const teamRows = userIds.length
      ? await this.db
          .select({
            userId: projectTeamMembers.userId,
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
          .where(
            and(
              eq(projectTeamMembers.orgId, orgId),
              inArray(projectTeamMembers.userId, userIds),
            ),
          )
      : [];

    const teamsByUser = new Map<string, string[]>();
    for (const t of teamRows) {
      const arr = teamsByUser.get(t.userId) ?? [];
      if (!arr.includes(t.teamName)) arr.push(t.teamName);
      teamsByUser.set(t.userId, arr);
    }

    return {
      data: rows.map((r) => ({ ...r, teams: teamsByUser.get(r.id) ?? [] })),
      total: Number(countRow?.total ?? 0),
      page: query.page,
      limit: query.limit,
    };
  }

  async add(orgId: string, actorId: string, input: AddWorkspaceMemberInput) {
    const [orgMember] = await this.db
      .select({ userId: organizationMembers.userId })
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
      const [row] = await this.db
        .insert(projectWorkspaceMembers)
        .values({ orgId, userId: input.userId, role: input.role })
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
    await this.db.transaction(async (tx) => {
      await tx
        .delete(projectWorkspaceMembers)
        .where(
          and(
            eq(projectWorkspaceMembers.orgId, orgId),
            eq(projectWorkspaceMembers.userId, userId),
          ),
        );
      await tx
        .delete(projectTeamMembers)
        .where(
          and(
            eq(projectTeamMembers.orgId, orgId),
            eq(projectTeamMembers.userId, userId),
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
    const [row] = await this.db
      .select({ id: projectWorkspaceMembers.id })
      .from(projectWorkspaceMembers)
      .where(
        and(
          eq(projectWorkspaceMembers.orgId, orgId),
          eq(projectWorkspaceMembers.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}
