import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../db/schema/common/organization";
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
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "TEAM"),
      isNull(orgUnits.deletedAt),
      ...(search ? [or(ilike(orgUnits.name, `%${search}%`), ilike(orgUnits.code, `%${search}%`))] : []),
      ...(status ? [sql`${orgUnits.status} = ${status}`] : []),
    );
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(orgUnits).where(filters).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(orgUnits).where(filters),
    ]);
    return { data: rows, total: count, page, limit };
  }

  async getTeam(orgId: string, id: string) {
    return (
      (await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
          isNull(orgUnits.deletedAt),
        ),
      })) ?? null
    );
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "TEAM"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Team code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "TEAM",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
        headUserId: body.leadUserId ?? undefined,
        parentId: body.departmentId ?? undefined,
        metadata: body.capacity !== undefined ? { capacity: body.capacity } : undefined,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.log({ action: "org.team.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateTeam(orgId: string, userId: string, id: string, body: UpdateOrgTeamInput) {
    const existing = await this.getTeam(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Team code already exists");
    }

    const { departmentId, leadUserId, capacity, code, ...rest } = body;
    const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(leadUserId !== undefined && { headUserId: leadUserId }),
        ...(departmentId !== undefined && { parentId: departmentId }),
        ...(capacity !== undefined && {
          metadata: { ...existingMeta, capacity: capacity ?? undefined },
        }),
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.log({ action: "org.team.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteTeam(orgId: string, userId: string, id: string) {
    const existing = await this.getTeam(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.log({ action: "org.team.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string | null) {
    const team = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, teamId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "TEAM"),
      ),
    });
    if (!team) throw new NotFoundException("Team not found");
    if (newDepartmentId !== null && newDepartmentId === teamId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newDepartmentId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, teamId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
