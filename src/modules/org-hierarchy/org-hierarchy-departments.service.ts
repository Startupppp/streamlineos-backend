import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgDepartments } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
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
}
