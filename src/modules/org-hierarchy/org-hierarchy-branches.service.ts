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
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "BRANCH"),
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

  async getOrgBranch(orgId: string, id: string) {
    return (
      (await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      })) ?? null
    );
  }

  async createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BRANCH"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Branch code already exists");

    const { address, city, state, country, postalCode, phone, email, businessUnitId, managerUserId, ...rest } = body;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "BRANCH",
        ...rest,
        code: body.code.toUpperCase(),
        headUserId: managerUserId ?? undefined,
        parentId: businessUnitId ?? undefined,
        metadata: {
          ...(address !== undefined && { address }),
          ...(city !== undefined && { city }),
          ...(state !== undefined && { state }),
          ...(country !== undefined && { country }),
          ...(postalCode !== undefined && { postalCode }),
          ...(phone !== undefined && { phone }),
          ...(email && email !== "" ? { email } : {}),
        },
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BRANCH"));
    await this.audit.log({ action: "org.branch.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateOrgBranch(orgId: string, userId: string, id: string, body: UpdateOrgBranchInput) {
    const existing = await this.getOrgBranch(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Branch code already exists");
    }

    const { address, city, state, country, postalCode, phone, email, businessUnitId, managerUserId, status, name, code } = body;
    const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>;

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(name !== undefined && { name }),
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(status !== undefined && { status }),
        ...(managerUserId !== undefined && { headUserId: managerUserId }),
        ...(businessUnitId !== undefined && { parentId: businessUnitId }),
        metadata: {
          ...existingMeta,
          ...(address !== undefined && { address }),
          ...(city !== undefined && { city }),
          ...(state !== undefined && { state }),
          ...(country !== undefined && { country }),
          ...(postalCode !== undefined && { postalCode }),
          ...(phone !== undefined && { phone }),
          ...(email !== undefined && { email: email || undefined }),
        },
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BRANCH")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BRANCH"));
    await this.audit.log({ action: "org.branch.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteOrgBranch(orgId: string, userId: string, id: string) {
    const existing = await this.getOrgBranch(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BRANCH")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BRANCH"));
    await this.audit.log({ action: "org.branch.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    const branch = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, branchId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BRANCH"),
      ),
    });
    if (!branch) throw new NotFoundException("Branch not found");
    if (newBusinessUnitId !== null && newBusinessUnitId === branchId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newBusinessUnitId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, branchId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
