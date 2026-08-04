import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { deals, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CreateDealInput, ListDealsInput } from "./dto/deals.schemas";

@Injectable()
export class DealsCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly crmValidation: CrmValidationService,
    private readonly bus: CrmAutomationBusService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  listDeals(orgId: string, userId: string, query: ListDealsInput, scope: DataScope) {
    const hash = Buffer.from(JSON.stringify({ ...query, userId, scope })).toString("base64");
    return this.cache.cachedVersioned(
      `deals:list:${orgId}`,
      hash,
      () => {
        const conditions: SQL[] = [
          eq(deals.orgId, orgId),
          applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId }),
        ];
        if (query.stage) conditions.push(eq(deals.stage, query.stage));
        if (query.assignedToId) conditions.push(eq(deals.assignedToId, query.assignedToId));

        return this.db.query.deals.findMany({
          where: and(...conditions),
          with: {
            assignedTo: { columns: { id: true, name: true, image: true } },
            lead: { columns: { id: true, name: true } },
            client: { columns: { id: true, name: true } },
          },
          orderBy: [desc(deals.updatedAt)],
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        });
      },
      CACHE_TTL.SHORT,
    );
  }

  async createDeal(orgId: string, userId: string, input: CreateDealInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmDeals");

    if (input.assignedToId && input.assignedToId !== userId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, input.assignedToId), eq(organizationMembers.orgId, orgId)),
        columns: { userId: true },
      });
      if (!member) throw new BadRequestException("Assigned user is not a member of this organization");
    }

    const validationRecord: Record<string, unknown> = {
      name: input.name,
      value: input.value ?? null,
      stage: input.stage ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
    };
    const validation = await this.crmValidation.evaluate(orgId, "deal", validationRecord, {
      stageKey: input.stage ?? undefined,
    });
    if (!validation.valid) {
      throw new BadRequestException(validation.errors.map((e) => e.message).join("; "));
    }

    const [deal] = await this.db
      .insert(deals)
      .values({
        orgId,
        name: input.name,
        value: String(input.value ?? 0),
        stage: input.stage,
        probability: input.probability ?? 0,
        contactPerson: input.contactPerson || null,
        contactEmail: input.contactEmail || null,
        contactPhone: input.contactPhone || null,
        assignedToId: input.assignedToId || userId,
        expectedCloseDate: input.expectedCloseDate || null,
        notes: input.notes || null,
        leadId: input.leadId || null,
        clientId: input.clientId || null,
      })
      .returning();

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.dealsForecast(orgId)),
      this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
      this.cache.invalidateNamespace(`deals:list:${orgId}`),
    ]);

    if (deal) {
      this.audit.log({
        action: "deal.created",
        userId,
        orgId,
        targetId: String(deal.id),
        targetType: "deal",
        metadata: { name: deal.name, stage: deal.stage, value: deal.value },
      });
      void this.bus.emit(orgId, "deal.created", { entityType: "deal", entityId: String(deal.id), data: { name: deal.name, stage: deal.stage, value: deal.value }, actorId: userId }).catch(() => undefined);
    }

    return deal;
  }

  getDeal(orgId: string, dealId: number) {
    return this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId)),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true } },
        lead: { columns: { id: true, name: true, email: true, phone: true } },
        client: { columns: { id: true, name: true } },
      },
    });
  }

  async deleteDeal(orgId: string, userId: string, dealId: number) {
    await this.db.delete(deals).where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));

    await Promise.all([
      this.cache.invalidateNamespace(`deals:list:${orgId}`),
      this.cache.invalidate(CACHE_KEYS.dealsForecast(orgId)),
    ]);

    this.audit.log({
      action: "deal.deleted",
      userId,
      orgId,
      targetId: String(dealId),
      targetType: "deal",
    });

    return { deleted: true };
  }

  async cloneDeal(orgId: string, dealId: number) {
    await this.planLimits.assertWithinLimit(orgId, "crmDeals");

    const existing = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Deal not found");

    const [cloned] = await this.db
      .insert(deals)
      .values({
        orgId,
        leadId: existing.leadId,
        clientId: existing.clientId,
        name: `${existing.name} (Copy)`,
        value: existing.value ?? "0",
        stage: "LEAD",
        probability: existing.probability ?? 0,
        contactPerson: existing.contactPerson,
        contactEmail: existing.contactEmail,
        contactPhone: existing.contactPhone,
        assignedToId: existing.assignedToId,
        notes: existing.notes,
      })
      .returning();

    return cloned;
  }
}
