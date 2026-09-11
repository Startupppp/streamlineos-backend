import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
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
import { toMinorUnits } from "./deal-stage-ledger";
import { withPartyLabels } from "./deal-party-projection";
import {
  bulkDelete,
  bulkUpdate,
  type DealBulkDeps,
} from "./lib/deal-bulk-ops";
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

        const rows = await this.db.query.deals.findMany({
          where: and(...conditions),
          with: {
            assignedTo: { columns: { id: true, name: true, image: true } },
          },
          orderBy: [desc(deals.updatedAt)],
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        });
        // `lead` and `client` come from Party now; see `deal-party-projection.ts`.
        // One extra statement for the page, not one per deal.
        return withPartyLabels(this.db, orgId, rows);
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

  /**
   * One deal, behind the SAME scope `listDeals` applies.
   *
   * `crm:deals:read` is declared `scopable: true`, and ninety lines above this
   * `listDeals` honours it — `applyScope(..., { ownerColumn: deals.assignedToId })`,
   * so a rep granted `own` sees only the deals assigned to them. This applied
   * nothing. Same file, same entity: the list narrowed and reading one by id did
   * not, so an organisation that had granted `own` to restrict a rep had not
   * restricted them at all, and believed it had.
   *
   * Returning `undefined` rather than throwing is deliberate and unchanged: the
   * controller turns it into 404, which is the same answer a deal in another
   * org gives, so this does not become an oracle for which deals exist.
   */
  async getDeal(orgId: string, userId: string, dealId: number, scope: DataScope) {
    const deal = await this.db.query.deals.findFirst({
      where: and(
        eq(deals.id, dealId),
        eq(deals.orgId, orgId),
        isNull(deals.deletedAt),
        applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId }),
      ),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true } },
      },
    });
    if (!deal) return deal;
    const [withLabels] = await withPartyLabels(this.db, orgId, [deal]);
    return withLabels;
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

  /** @see lib/deal-bulk-ops.ts */
  async bulkUpdate(orgId: string, userId: string, input: DealBulkUpdateInput) {
    return bulkUpdate(this.bulkDeps, orgId, userId, input);
  }

  /** @see lib/deal-bulk-ops.ts */
  async bulkDelete(orgId: string, userId: string, input: DealBulkDeleteInput) {
    return bulkDelete(this.bulkDeps, orgId, userId, input);
  }

  private get bulkDeps(): DealBulkDeps {
    return { db: this.db, cache: this.cache, audit: this.audit };
  }

  /**
   * Clone one, out of the deals the caller may read.
   *
   * The route is gated on `crm:deals:create`, but the SOURCE is a read and takes
   * the read scope: you may copy a deal you could have opened. Unscoped, a rep
   * at `own` could clone a colleague's deal — reading its value, contact email,
   * phone and notes into a new record on the way, and spending one of the plan's
   * deal slots. The copy keeps `assignedToId`, so it lands in that colleague's
   * pipeline, which makes it quiet as well as wrong.
   */
  async cloneDeal(orgId: string, userId: string, dealId: number, scope: DataScope) {
    await this.planLimits.assertWithinLimit(orgId, "crmDeals");

    const existing = await this.db.query.deals.findFirst({
      where: and(
        eq(deals.id, dealId),
        eq(deals.orgId, orgId),
        isNull(deals.deletedAt),
        applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId }),
      ),
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
