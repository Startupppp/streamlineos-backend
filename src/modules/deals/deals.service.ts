import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { deals, dealActivities, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CreateDealInput, ListDealsInput, LogActivityInput, PatchCustomDataInput, UpdateDealInput } from "./dto/deals.schemas";

type DealRow = typeof deals.$inferSelect;

export type UpdateDealOutcome =
  | { ok: true; deal: DealRow; stageChanged: boolean }
  | { ok: false; reason: "version_conflict" | "not_found" };

@Injectable()
export class DealsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  listDeals(orgId: string, role: string, userId: string, query: ListDealsInput) {
    const hash = Buffer.from(JSON.stringify({ ...query, userId, role })).toString("base64");
    return this.cache.cached(
      CACHE_KEYS.dealsList(orgId, hash),
      () => {
        const conditions = [eq(deals.orgId, orgId)];
        if (role === "SALES" && userId) conditions.push(eq(deals.assignedToId, userId));
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
    if (input.assignedToId && input.assignedToId !== userId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, input.assignedToId), eq(organizationMembers.orgId, orgId)),
        columns: { userId: true },
      });
      if (!member) throw new BadRequestException("Assigned user is not a member of this organization");
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
      this.cache.invalidatePattern(`deals:list:${orgId}:*`),
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
    }

    return deal;
  }

  async updateDeal(orgId: string, userId: string, dealId: number, input: UpdateDealInput): Promise<UpdateDealOutcome> {
    const updateData: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
    let stageChanged = false;

    if (input.stage !== undefined) {
      const existing = await this.db.query.deals.findFirst({
        where: and(eq(deals.id, dealId), eq(deals.orgId, orgId)),
        columns: { stage: true, updatedAt: true },
      });

      if (input.version && existing?.updatedAt) {
        const clientVersion = new Date(input.version).getTime();
        const serverVersion = new Date(existing.updatedAt).getTime();
        if (clientVersion < serverVersion) {
          return { ok: false, reason: "version_conflict" };
        }
      }

      if (input.stage === "WON") {
        updateData.actualCloseDate = new Date().toISOString().split("T")[0];
        updateData.probability = 100;
      } else if (input.stage === "LOST") {
        updateData.actualCloseDate = new Date().toISOString().split("T")[0];
        updateData.probability = 0;
      }

      if (existing && existing.stage !== input.stage) {
        stageChanged = true;
        await this.db.insert(dealActivities).values({
          orgId,
          dealId,
          type: "stage_change",
          previousValue: existing.stage,
          newValue: input.stage,
          subject: `Stage changed from ${existing.stage} to ${input.stage}`,
          userId,
        });
      }
    }

    if (input.name !== undefined) updateData.name = input.name;
    if (input.value !== undefined) updateData.value = String(input.value);
    if (input.stage !== undefined) updateData.stage = input.stage;
    if (input.probability !== undefined) updateData.probability = input.probability;
    if (input.contactPerson !== undefined) updateData.contactPerson = input.contactPerson;
    if (input.contactEmail !== undefined) updateData.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) updateData.contactPhone = input.contactPhone;
    if (input.assignedToId !== undefined) updateData.assignedToId = input.assignedToId;
    if (input.expectedCloseDate !== undefined) updateData.expectedCloseDate = input.expectedCloseDate;
    if (input.actualCloseDate !== undefined) updateData.actualCloseDate = input.actualCloseDate;
    if (input.lostReason !== undefined) updateData.lostReason = input.lostReason;
    if (input.notes !== undefined) updateData.notes = input.notes;

    const [updated] = await this.db
      .update(deals)
      .set(updateData)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)))
      .returning();

    if (!updated) return { ok: false, reason: "not_found" };

    const invalidations: Array<Promise<void>> = [
      this.cache.invalidatePattern(`deals:list:${orgId}:*`),
      this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
    ];
    if (stageChanged) {
      invalidations.push(this.cache.invalidate(CACHE_KEYS.salesKpis(orgId)));
    }
    await Promise.all(invalidations);

    this.audit.log({
      action: stageChanged ? "deal.stage_changed" : "deal.updated",
      userId,
      orgId,
      targetId: String(dealId),
      targetType: "deal",
      metadata: { changedFields: Object.keys(input), newStage: input.stage },
    });

    return { ok: true, deal: updated, stageChanged };
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
      this.cache.invalidatePattern(`deals:list:${orgId}:*`),
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

  listActivities(orgId: string, dealId: number) {
    return this.db
      .select()
      .from(dealActivities)
      .where(and(eq(dealActivities.dealId, dealId), eq(dealActivities.orgId, orgId)))
      .orderBy(desc(dealActivities.createdAt))
      .limit(50);
  }

  async addActivity(orgId: string, userId: string, dealId: number, input: LogActivityInput) {
    const [deal] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));
    if (!deal) throw new NotFoundException("Deal not found");

    const [activity] = await this.db
      .insert(dealActivities)
      .values({
        orgId,
        dealId,
        type: input.type,
        subject: input.subject ?? null,
        notes: input.notes ?? null,
        duration: input.duration ?? null,
        previousValue: input.previousValue ?? null,
        newValue: input.newValue ?? null,
        userId,
      })
      .returning();

    await this.db
      .update(deals)
      .set({ lastContactDate: new Date(), updatedAt: new Date() })
      .where(eq(deals.id, dealId));

    return activity;
  }

  async updateCustomData(orgId: string, dealId: number, input: PatchCustomDataInput) {
    const [existing] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)))
      .limit(1);
    if (!existing) throw new NotFoundException("Deal not found");

    const [updated] = await this.db
      .update(deals)
      .set({ customData: input.customData, updatedAt: new Date() })
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)))
      .returning();

    return { customData: updated.customData };
  }
}
