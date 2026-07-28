import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgBusinessUnits } from "../../db/schema/common/organization";
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

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    const bu = await this.db.query.orgBusinessUnits.findFirst({
      where: and(eq(orgBusinessUnits.id, buId), eq(orgBusinessUnits.orgId, orgId)),
    });
    if (!bu) throw new Error("Business unit not found");

    await this.db
      .update(orgBusinessUnits)
      .set({ updatedAt: new Date() })
      .where(and(eq(orgBusinessUnits.id, buId), eq(orgBusinessUnits.orgId, orgId)));

    return { success: true };
  }
}
