import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgCostCenters } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type {
  CreateCostCenterInput,
  UpdateCostCenterInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyCostCentersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

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
}
