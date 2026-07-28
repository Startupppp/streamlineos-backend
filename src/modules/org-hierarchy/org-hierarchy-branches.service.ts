import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgBranches } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyBranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

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
}
