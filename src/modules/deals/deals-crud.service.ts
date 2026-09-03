import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { and, count, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { deals, dealStageTransitions, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { toMinorUnits, toTransitionRow } from "./deal-stage-ledger";
import { buildListResponse } from "../../common/pagination/pagination";
import type {
  CreateDealInput,
  DealBulkDeleteInput,
  DealBulkUpdateInput,
  ListDealsInput,
} from "./dto/deals.schemas";

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
      async () => {
        const conditions: SQL[] = [
          eq(deals.orgId, orgId), isNull(deals.deletedAt),
          applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId }),
        ];
        if (query.stage) conditions.push(eq(deals.stage, query.stage));
        if (query.assignedToId) conditions.push(eq(deals.assignedToId, query.assignedToId));

        const where = and(...conditions);
        const pageSize = query.limit ?? 50;
        const offset = query.offset ?? 0;

        const [rows, [totalRow]] = await Promise.all([
          this.db.query.deals.findMany({
            where,
            with: {
              assignedTo: { columns: { id: true, name: true, image: true } },
              lead: { columns: { id: true, name: true } },
              client: { columns: { id: true, name: true } },
            },
            orderBy: [desc(deals.updatedAt)],
            limit: pageSize,
            offset,
          }),
          this.db.select({ total: count() }).from(deals).where(where),
        ]);

        // This list pages by `offset`, so the envelope's page number is derived from it.
        return buildListResponse(rows, Number(totalRow?.total ?? 0), {
          page: pageSize > 0 ? Math.floor(offset / pageSize) + 1 : 1,
          pageSize,
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
        // `value` is generated from this column now, so writing it would error.
        valueMinor: toMinorUnits(input.value),
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
        partyId: input.partyId || null,
        subjectId: input.subjectId || null,
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
      void this.bus.emit(orgId, "deal.created", { entityType: "deal", entityId: String(deal.id), data: { name: deal.name, stage: deal.stage, value: deal.value }, actorId: userId }).catch(logSideEffectFailure("deal.created bus emit", { orgId, dealId: deal.id }));
    }

    return deal;
  }

  getDeal(orgId: string, dealId: number) {
    return this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true } },
        lead: { columns: { id: true, name: true, email: true, phone: true } },
        client: { columns: { id: true, name: true } },
      },
    });
  }

  async deleteDeal(orgId: string, userId: string, dealId: number) {
    await this.db
      .update(deals)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
      );

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

  /**
   * One batched UPDATE rather than N single writes: the whole selection either
   * moves or it does not, and the row count comes from `.returning()` so a
   * caller passing another tenant's ids is told 0, not "success".
   */
  async bulkUpdate(orgId: string, userId: string, input: DealBulkUpdateInput) {
    const setData: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
    if (input.update.stage !== undefined) setData.stage = input.update.stage;

    if (input.update.assignedToId !== undefined) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, input.update.assignedToId),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { userId: true },
      });
      if (!member) throw new BadRequestException("Assignee is not a member of this organization");
      setData.assignedToId = input.update.assignedToId;
    }

    /**
     * A bulk stage change is still a stage change.
     *
     * This path used to move any number of deals with no transition recorded at
     * all, so the pipeline's own history depended on which screen a person
     * happened to use. The prior stages are read and the ledger written inside
     * the same transaction as the update, so a rolled-back move leaves no row
     * claiming it happened.
     */
    const updated = await this.db.transaction(async (tx) => {
      const before =
        setData.stage === undefined
          ? []
          : await (tx as Db)
              .select({ id: deals.id, stage: deals.stage, pipelineId: deals.pipelineId })
              .from(deals)
              .where(
                and(
                  eq(deals.orgId, orgId),
                  inArray(deals.id, input.dealIds),
                  isNull(deals.deletedAt),
                ),
              );

      const rows = await (tx as Db)
        .update(deals)
        .set(setData)
        .where(
          and(
            eq(deals.orgId, orgId),
            inArray(deals.id, input.dealIds),
            isNull(deals.deletedAt),
          ),
        )
        .returning({ id: deals.id });

      const toStage = setData.stage;
      if (toStage !== undefined) {
        const moved = before.filter((deal) => deal.stage !== toStage);
        if (moved.length > 0)
          await (tx as Db).insert(dealStageTransitions).values(
            moved.map((deal) =>
              toTransitionRow({
                organizationId: orgId,
                dealId: deal.id,
                pipelineId: deal.pipelineId ?? null,
                fromStage: deal.stage ?? null,
                toStage,
                actor: { kind: "human", userId },
                reason: "Bulk stage change",
              }),
            ),
          );
      }

      return rows;
    });

    await this.invalidateDealCaches(orgId);
    this.audit.log({
      action: "deal.bulk_updated",
      userId,
      orgId,
      targetType: "deal",
      metadata: { requested: input.dealIds.length, updated: updated.length, update: input.update },
    });

    return { updated: updated.length, requested: input.dealIds.length };
  }

  async bulkDelete(orgId: string, userId: string, input: DealBulkDeleteInput) {
    const deleted = await this.db
      .update(deals)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(deals.orgId, orgId),
          inArray(deals.id, input.dealIds),
          isNull(deals.deletedAt),
        ),
      )
      .returning({ id: deals.id });

    await this.invalidateDealCaches(orgId);
    this.audit.log({
      action: "deal.bulk_deleted",
      userId,
      orgId,
      targetType: "deal",
      metadata: { requested: input.dealIds.length, deleted: deleted.length },
    });

    return { deleted: deleted.length, requested: input.dealIds.length };
  }

  private async invalidateDealCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(`deals:list:${orgId}`),
      this.cache.invalidate(CACHE_KEYS.dealsForecast(orgId)),
      this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
    ]);
  }

  async cloneDeal(orgId: string, dealId: number) {
    await this.planLimits.assertWithinLimit(orgId, "crmDeals");

    const existing = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
    });
    if (!existing) throw new NotFoundException("Deal not found");

    const [cloned] = await this.db
      .insert(deals)
      .values({
        orgId,
        leadId: existing.leadId,
        clientId: existing.clientId,
        name: `${existing.name} (Copy)`,
        valueMinor: existing.valueMinor,
        stage: "LEAD",
        partyId: existing.partyId,
        subjectId: existing.subjectId,
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
