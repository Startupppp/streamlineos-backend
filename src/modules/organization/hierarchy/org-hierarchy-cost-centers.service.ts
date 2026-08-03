import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
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
      CACHE_KEYS.orgUnits(orgId, "COST_CENTER"),
      () =>
        this.db
          .select()
          .from(orgUnits)
          .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "COST_CENTER"))),
      CACHE_TTL.MEDIUM,
    );
  }

  async getCostCenter(orgId: string, id: string) {
    return (
      (await this.db.query.orgUnits.findFirst({
        where: and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "COST_CENTER")),
      })) ?? null
    );
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "COST_CENTER"),
        eq(orgUnits.code, body.code.toUpperCase()),
      ),
    });
    if (conflict) throw new ConflictException("Cost center code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "COST_CENTER",
        code: body.code.toUpperCase(),
        name: body.name,
        description: body.description,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "COST_CENTER"));
    await this.audit.log({ action: "org.costCenter.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateCostCenter(orgId: string, userId: string, id: string, body: UpdateCostCenterInput) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "COST_CENTER"),
          eq(orgUnits.code, body.code.toUpperCase()),
        ),
      });
      if (conflict) throw new ConflictException("Cost center code already exists");
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, code: body.code?.toUpperCase() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "COST_CENTER")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "COST_CENTER"));
    await this.audit.log({ action: "org.costCenter.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteCostCenter(orgId: string, userId: string, id: string) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    await this.db
      .delete(orgUnits)
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "COST_CENTER")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "COST_CENTER"));
    await this.audit.log({ action: "org.costCenter.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }
}
