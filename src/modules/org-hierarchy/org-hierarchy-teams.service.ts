import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgTeams } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyTeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listTeams(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgTeams.orgId, orgId),
      isNull(orgTeams.deletedAt),
      ...(search ? [or(ilike(orgTeams.name, `%${search}%`), ilike(orgTeams.code, `%${search}%`))] : []),
      ...(status ? [sql`${orgTeams.status} = ${status}`] : []),
    );
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(orgTeams).where(filters).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(orgTeams).where(filters),
    ]);
    return { data: rows, total: count, page, limit };
  }

  async getTeam(orgId: string, id: string) {
    return (
      (await this.db.query.orgTeams.findFirst({
        where: and(
          eq(orgTeams.id, id),
          eq(orgTeams.orgId, orgId),
          isNull(orgTeams.deletedAt),
        ),
      })) ?? null
    );
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    const conflict = await this.db.query.orgTeams.findFirst({
      where: and(
        eq(orgTeams.orgId, orgId),
        eq(orgTeams.code, body.code.toUpperCase()),
        isNull(orgTeams.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Team code already exists");

    const [row] = await this.db
      .insert(orgTeams)
      .values({ id: randomUUID(), orgId, ...body, code: body.code.toUpperCase() })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgTeams(orgId));
    await this.audit.log({ action: "org.team.created", userId, orgId, targetId: row!.id, targetType: "org_team" });

    return row;
  }

  async updateTeam(orgId: string, userId: string, id: string, body: UpdateOrgTeamInput) {
    const existing = await this.getTeam(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgTeams.findFirst({
        where: and(
          eq(orgTeams.orgId, orgId),
          eq(orgTeams.code, body.code.toUpperCase()),
          isNull(orgTeams.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Team code already exists");
    }

    const [row] = await this.db
      .update(orgTeams)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgTeams.id, id), eq(orgTeams.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgTeams(orgId));
    await this.audit.log({ action: "org.team.updated", userId, orgId, targetId: id, targetType: "org_team" });

    return row;
  }

  async deleteTeam(orgId: string, userId: string, id: string) {
    const existing = await this.getTeam(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");

    await this.db
      .update(orgTeams)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgTeams.id, id), eq(orgTeams.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgTeams(orgId));
    await this.audit.log({ action: "org.team.deleted", userId, orgId, targetId: id, targetType: "org_team" });
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string | null) {
    const team = await this.db.query.orgTeams.findFirst({
      where: and(eq(orgTeams.id, teamId), eq(orgTeams.orgId, orgId)),
    });
    if (!team) throw new Error("Team not found");

    await this.db
      .update(orgTeams)
      .set({ departmentId: newDepartmentId, updatedAt: new Date() })
      .where(and(eq(orgTeams.id, teamId), eq(orgTeams.orgId, orgId)));

    return { success: true };
  }
}
