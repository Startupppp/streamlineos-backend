import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  orgBusinessUnits,
  orgBranches,
  orgDepartments,
  orgTeams,
  orgLocations,
  orgCostCenters,
} from "../../db/schema/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  CreateOrgLocationInput,
  UpdateOrgLocationInput,
  CreateCostCenterInput,
  UpdateCostCenterInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";

type NodeStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";

function activeFilter<T extends { status: NodeStatus; deletedAt: Date | null }>(
  rows: T[],
): T[] {
  return rows.filter((r) => r.status !== "ARCHIVED" && !r.deletedAt);
}

function buildSearchWhere(search: string | undefined, nameCol: unknown, codeCol: unknown) {
  if (!search) return undefined;
  const term = `%${search}%`;
  return or(ilike(nameCol as Parameters<typeof ilike>[0], term), ilike(codeCol as Parameters<typeof ilike>[0], term));
}

@Injectable()
export class OrgHierarchyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  // ─── Business Units ───────────────────────────────────────────────────

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgBusinessUnits.orgId, orgId),
      isNull(orgBusinessUnits.deletedAt),
      ...(search ? [or(ilike(orgBusinessUnits.name, `%${search}%`), ilike(orgBusinessUnits.code, `%${search}%`))] : []),
      ...(status ? [sql`${orgBusinessUnits.status} = ${status}`] : []),
    );
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(orgBusinessUnits).where(filters).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(orgBusinessUnits).where(filters),
    ]);
    return { data: rows, total: count, page, limit };
  }

  async getBusinessUnit(orgId: string, id: string) {
    const row = await this.db.query.orgBusinessUnits.findFirst({
      where: and(
        eq(orgBusinessUnits.id, id),
        eq(orgBusinessUnits.orgId, orgId),
        isNull(orgBusinessUnits.deletedAt),
      ),
    });
    return row ?? null;
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    const existing = await this.db.query.orgBusinessUnits.findFirst({
      where: and(
        eq(orgBusinessUnits.orgId, orgId),
        eq(orgBusinessUnits.code, body.code.toUpperCase()),
        isNull(orgBusinessUnits.deletedAt),
      ),
    });
    if (existing) throw new ConflictException("Business unit code already exists");

    const [row] = await this.db
      .insert(orgBusinessUnits)
      .values({
        id: randomUUID(),
        orgId,
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgBusinessUnits(orgId));
    await this.audit.log({ action: "org.businessUnit.created", userId, orgId, targetId: row!.id, targetType: "org_business_unit" });

    return row;
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgBusinessUnits.findFirst({
        where: and(
          eq(orgBusinessUnits.orgId, orgId),
          eq(orgBusinessUnits.code, body.code.toUpperCase()),
          isNull(orgBusinessUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Business unit code already exists");
    }

    const [row] = await this.db
      .update(orgBusinessUnits)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgBusinessUnits.id, id), eq(orgBusinessUnits.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgBusinessUnits(orgId));
    await this.audit.log({ action: "org.businessUnit.updated", userId, orgId, targetId: id, targetType: "org_business_unit" });

    return row;
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    await this.db
      .update(orgBusinessUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgBusinessUnits.id, id), eq(orgBusinessUnits.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgBusinessUnits(orgId));
    await this.audit.log({ action: "org.businessUnit.deleted", userId, orgId, targetId: id, targetType: "org_business_unit" });
  }

  // ─── Org Branches ─────────────────────────────────────────────────────

  async listOrgBranches(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgBranches.orgId, orgId),
      isNull(orgBranches.deletedAt),
      ...(search ? [or(ilike(orgBranches.name, `%${search}%`), ilike(orgBranches.code, `%${search}%`))] : []),
      ...(status ? [sql`${orgBranches.status} = ${status}`] : []),
    );
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(orgBranches).where(filters).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(orgBranches).where(filters),
    ]);
    return { data: rows, total: count, page, limit };
  }

  async getOrgBranch(orgId: string, id: string) {
    return (
      (await this.db.query.orgBranches.findFirst({
        where: and(
          eq(orgBranches.id, id),
          eq(orgBranches.orgId, orgId),
          isNull(orgBranches.deletedAt),
        ),
      })) ?? null
    );
  }

  async createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    const conflict = await this.db.query.orgBranches.findFirst({
      where: and(
        eq(orgBranches.orgId, orgId),
        eq(orgBranches.code, body.code.toUpperCase()),
        isNull(orgBranches.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Branch code already exists");

    const [row] = await this.db
      .insert(orgBranches)
      .values({
        id: randomUUID(),
        orgId,
        ...body,
        code: body.code.toUpperCase(),
        email: body.email || undefined,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgBranches(orgId));
    await this.audit.log({ action: "org.branch.created", userId, orgId, targetId: row!.id, targetType: "org_branch" });

    return row;
  }

  async updateOrgBranch(orgId: string, userId: string, id: string, body: UpdateOrgBranchInput) {
    const existing = await this.getOrgBranch(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgBranches.findFirst({
        where: and(
          eq(orgBranches.orgId, orgId),
          eq(orgBranches.code, body.code.toUpperCase()),
          isNull(orgBranches.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Branch code already exists");
    }

    const [row] = await this.db
      .update(orgBranches)
      .set({ ...body, code: body.code?.toUpperCase(), email: body.email || undefined })
      .where(and(eq(orgBranches.id, id), eq(orgBranches.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgBranches(orgId));
    await this.audit.log({ action: "org.branch.updated", userId, orgId, targetId: id, targetType: "org_branch" });

    return row;
  }

  async deleteOrgBranch(orgId: string, userId: string, id: string) {
    const existing = await this.getOrgBranch(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    await this.db
      .update(orgBranches)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgBranches.id, id), eq(orgBranches.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgBranches(orgId));
    await this.audit.log({ action: "org.branch.deleted", userId, orgId, targetId: id, targetType: "org_branch" });
  }

  // ─── Departments ──────────────────────────────────────────────────────

  async listDepartments(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgDepartments.orgId, orgId),
      isNull(orgDepartments.deletedAt),
      ...(search ? [or(ilike(orgDepartments.name, `%${search}%`), ilike(orgDepartments.code, `%${search}%`))] : []),
      ...(status ? [sql`${orgDepartments.status} = ${status}`] : []),
    );
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(orgDepartments).where(filters).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(orgDepartments).where(filters),
    ]);
    return { data: rows, total: count, page, limit };
  }

  async getDepartment(orgId: string, id: string) {
    return (
      (await this.db.query.orgDepartments.findFirst({
        where: and(
          eq(orgDepartments.id, id),
          eq(orgDepartments.orgId, orgId),
          isNull(orgDepartments.deletedAt),
        ),
      })) ?? null
    );
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    const conflict = await this.db.query.orgDepartments.findFirst({
      where: and(
        eq(orgDepartments.orgId, orgId),
        eq(orgDepartments.code, body.code.toUpperCase()),
        isNull(orgDepartments.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Department code already exists");

    const [row] = await this.db
      .insert(orgDepartments)
      .values({ id: randomUUID(), orgId, ...body, code: body.code.toUpperCase() })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgDepartments(orgId));
    await this.audit.log({ action: "org.department.created", userId, orgId, targetId: row!.id, targetType: "org_department" });

    return row;
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgDepartments.findFirst({
        where: and(
          eq(orgDepartments.orgId, orgId),
          eq(orgDepartments.code, body.code.toUpperCase()),
          isNull(orgDepartments.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Department code already exists");
    }

    const [row] = await this.db
      .update(orgDepartments)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgDepartments.id, id), eq(orgDepartments.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgDepartments(orgId));
    await this.audit.log({ action: "org.department.updated", userId, orgId, targetId: id, targetType: "org_department" });

    return row;
  }

  async deleteDepartment(orgId: string, userId: string, id: string) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    await this.db
      .update(orgDepartments)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgDepartments.id, id), eq(orgDepartments.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgDepartments(orgId));
    await this.audit.log({ action: "org.department.deleted", userId, orgId, targetId: id, targetType: "org_department" });
  }

  // ─── Teams ────────────────────────────────────────────────────────────

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

  // ─── Locations ────────────────────────────────────────────────────────

  listLocations(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.orgLocations(orgId),
      () =>
        this.db
          .select()
          .from(orgLocations)
          .where(eq(orgLocations.orgId, orgId)),
      CACHE_TTL.MEDIUM,
    );
  }

  async getLocation(orgId: string, id: string) {
    return (
      (await this.db.query.orgLocations.findFirst({
        where: and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)),
      })) ?? null
    );
  }

  async createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    const [row] = await this.db
      .insert(orgLocations)
      .values({
        id: randomUUID(),
        orgId,
        name: body.name,
        type: body.type ?? "OFFICE",
        address: body.address,
        latitude: body.latitude?.toString(),
        longitude: body.longitude?.toString(),
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.created", userId, orgId, targetId: row!.id, targetType: "org_location" });

    return row;
  }

  async updateLocation(orgId: string, userId: string, id: string, body: UpdateOrgLocationInput) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    const [row] = await this.db
      .update(orgLocations)
      .set({
        ...body,
        latitude: body.latitude?.toString() ?? (body.latitude === null ? null : undefined),
        longitude: body.longitude?.toString() ?? (body.longitude === null ? null : undefined),
      })
      .where(and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.updated", userId, orgId, targetId: id, targetType: "org_location" });

    return row;
  }

  async deleteLocation(orgId: string, userId: string, id: string) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    await this.db
      .delete(orgLocations)
      .where(and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.deleted", userId, orgId, targetId: id, targetType: "org_location" });
  }

  // ─── Cost Centers ─────────────────────────────────────────────────────

  listCostCenters(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.orgCostCenters(orgId),
      () =>
        this.db
          .select()
          .from(orgCostCenters)
          .where(eq(orgCostCenters.orgId, orgId)),
      CACHE_TTL.MEDIUM,
    );
  }

  async getCostCenter(orgId: string, id: string) {
    return (
      (await this.db.query.orgCostCenters.findFirst({
        where: and(eq(orgCostCenters.id, id), eq(orgCostCenters.orgId, orgId)),
      })) ?? null
    );
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    const conflict = await this.db.query.orgCostCenters.findFirst({
      where: and(
        eq(orgCostCenters.orgId, orgId),
        eq(orgCostCenters.code, body.code.toUpperCase()),
      ),
    });
    if (conflict) throw new ConflictException("Cost center code already exists");

    const [row] = await this.db
      .insert(orgCostCenters)
      .values({
        id: randomUUID(),
        orgId,
        code: body.code.toUpperCase(),
        name: body.name,
        description: body.description,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgCostCenters(orgId));
    await this.audit.log({ action: "org.costCenter.created", userId, orgId, targetId: row!.id, targetType: "org_cost_center" });

    return row;
  }

  async updateCostCenter(orgId: string, userId: string, id: string, body: UpdateCostCenterInput) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgCostCenters.findFirst({
        where: and(
          eq(orgCostCenters.orgId, orgId),
          eq(orgCostCenters.code, body.code.toUpperCase()),
        ),
      });
      if (conflict) throw new ConflictException("Cost center code already exists");
    }

    const [row] = await this.db
      .update(orgCostCenters)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgCostCenters.id, id), eq(orgCostCenters.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgCostCenters(orgId));
    await this.audit.log({ action: "org.costCenter.updated", userId, orgId, targetId: id, targetType: "org_cost_center" });

    return row;
  }

  async deleteCostCenter(orgId: string, userId: string, id: string) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    await this.db
      .delete(orgCostCenters)
      .where(and(eq(orgCostCenters.id, id), eq(orgCostCenters.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgCostCenters(orgId));
    await this.audit.log({ action: "org.costCenter.deleted", userId, orgId, targetId: id, targetType: "org_cost_center" });
  }

  // ─── Hierarchy Overview ───────────────────────────────────────────────

  async getHierarchy(orgId: string) {
    const [bus, branches, depts, teams, locations, costCenters] = await Promise.all([
      this.db.select().from(orgBusinessUnits).where(and(eq(orgBusinessUnits.orgId, orgId), isNull(orgBusinessUnits.deletedAt))),
      this.db.select().from(orgBranches).where(and(eq(orgBranches.orgId, orgId), isNull(orgBranches.deletedAt))),
      this.db.select().from(orgDepartments).where(and(eq(orgDepartments.orgId, orgId), isNull(orgDepartments.deletedAt))),
      this.db.select().from(orgTeams).where(and(eq(orgTeams.orgId, orgId), isNull(orgTeams.deletedAt))),
      this.db.select().from(orgLocations).where(eq(orgLocations.orgId, orgId)),
      this.db.select().from(orgCostCenters).where(eq(orgCostCenters.orgId, orgId)),
    ]);

    return {
      businessUnits: bus.length,
      branches: branches.length,
      departments: depts.length,
      teams: teams.length,
      locations: locations.length,
      costCenters: costCenters.length,
    };
  }

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    const bu = await this.db.query.orgBusinessUnits.findFirst({
      where: and(eq(orgBusinessUnits.id, buId), eq(orgBusinessUnits.orgId, orgId)),
    });
    if (!bu) throw new Error("Business unit not found");

    if (newParentId !== null) {
      throw new BadRequestException("Business units cannot be reparented");
    }

    return { success: true };
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    const branch = await this.db.query.orgBranches.findFirst({
      where: and(eq(orgBranches.id, branchId), eq(orgBranches.orgId, orgId)),
    });
    if (!branch) throw new Error("Branch not found");

    await this.db
      .update(orgBranches)
      .set({ businessUnitId: newBusinessUnitId, updatedAt: new Date() })
      .where(and(eq(orgBranches.id, branchId), eq(orgBranches.orgId, orgId)));

    return { success: true };
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    const dept = await this.db.query.orgDepartments.findFirst({
      where: and(eq(orgDepartments.id, departmentId), eq(orgDepartments.orgId, orgId)),
    });
    if (!dept) throw new Error("Department not found");

    await this.db
      .update(orgDepartments)
      .set({ branchId: newBranchId, updatedAt: new Date() })
      .where(and(eq(orgDepartments.id, departmentId), eq(orgDepartments.orgId, orgId)));

    return { success: true };
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

  async getTree(orgId: string) {
    const [bus, branches, depts, teams] = await Promise.all([
      this.db.select().from(orgBusinessUnits).where(and(eq(orgBusinessUnits.orgId, orgId), isNull(orgBusinessUnits.deletedAt))),
      this.db.select().from(orgBranches).where(and(eq(orgBranches.orgId, orgId), isNull(orgBranches.deletedAt))),
      this.db.select().from(orgDepartments).where(and(eq(orgDepartments.orgId, orgId), isNull(orgDepartments.deletedAt))),
      this.db.select().from(orgTeams).where(and(eq(orgTeams.orgId, orgId), isNull(orgTeams.deletedAt))),
    ]);

    return bus.map((bu) => ({
      ...bu,
      type: "business_unit",
      children: branches
        .filter((b) => b.businessUnitId === bu.id)
        .map((branch) => ({
          ...branch,
          type: "branch",
          children: depts
            .filter((d) => d.branchId === branch.id)
            .map((dept) => ({
              ...dept,
              type: "department",
              children: teams
                .filter((t) => t.departmentId === dept.id)
                .map((team) => ({ ...team, type: "team", children: [] })),
            })),
        })),
    }));
  }
}
