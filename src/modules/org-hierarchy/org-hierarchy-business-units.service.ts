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
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyBusinessUnitsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    const { page, limit, search, status } = query;
    const offset = (page - 1) * limit;
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "BUSINESS_UNIT"),
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

  async getBusinessUnit(orgId: string, id: string) {
    const row = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, id),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BUSINESS_UNIT"),
        isNull(orgUnits.deletedAt),
      ),
    });
    return row ?? null;
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    const existing = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BUSINESS_UNIT"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (existing) throw new ConflictException("Business unit code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "BUSINESS_UNIT",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BUSINESS_UNIT"));
    await this.audit.log({ action: "org.businessUnit.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BUSINESS_UNIT"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Business unit code already exists");
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BUSINESS_UNIT")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BUSINESS_UNIT"));
    await this.audit.log({ action: "org.businessUnit.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BUSINESS_UNIT")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "BUSINESS_UNIT"));
    await this.audit.log({ action: "org.businessUnit.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    const bu = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, buId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BUSINESS_UNIT"),
      ),
    });
    if (!bu) throw new NotFoundException("Business unit not found");
    if (newParentId !== null && newParentId === buId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newParentId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, buId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
