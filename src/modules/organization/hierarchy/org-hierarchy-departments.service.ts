import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyDepartmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listDepartments(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "DEPARTMENT"),
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

  async getDepartment(orgId: string, id: string) {
    return (
      (await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
        ),
      })) ?? null
    );
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Department code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "DEPARTMENT",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
        headUserId: body.headUserId ?? undefined,
        parentId: body.branchId ?? undefined,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "DEPARTMENT"));
    await this.audit.log({ action: "org.department.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Department code already exists");
    }

    const { branchId, headUserId, code, ...rest } = body;
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(headUserId !== undefined && { headUserId }),
        ...(branchId !== undefined && { parentId: branchId }),
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "DEPARTMENT"));
    await this.audit.log({ action: "org.department.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteDepartment(orgId: string, userId: string, id: string) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "DEPARTMENT"));
    await this.audit.log({ action: "org.department.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    const dept = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, departmentId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
      ),
    });
    if (!dept) throw new NotFoundException("Department not found");
    if (newBranchId !== null && newBranchId === departmentId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newBranchId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, departmentId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
