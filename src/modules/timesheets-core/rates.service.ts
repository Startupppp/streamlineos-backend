import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetRates, timesheetRateCards } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import type { CreateRateInput, UpdateRateInput } from "./dto/rates.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class RatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async listRates(u: CurrentUserContext) {
    const [rates, rateCards] = await Promise.all([
      this.db.select().from(timesheetRates).where(eq(timesheetRates.orgId, u.orgId)),
      this.db.select().from(timesheetRateCards).where(eq(timesheetRateCards.orgId, u.orgId)),
    ]);
    return { rates, rateCards };
  }

  async createRate(u: CurrentUserContext, input: CreateRateInput) {
    const [rate] = await this.db
      .insert(timesheetRates)
      .values({
        orgId: u.orgId,
        projectId: input.projectId ?? null,
        userId: input.userId ?? null,
        taskId: input.taskId ?? null,
        clientId: input.clientId ?? null,
        billingType: input.billingType ?? "BILLABLE",
        billRate: input.billRate.toString(),
        costRate: input.costRate?.toString() ?? null,
        currency: input.currency ?? "USD",
        priority: input.priority ?? 0,
        rateCardId: input.rateCardId ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
      })
      .returning();

    if (!rate) throw new NotFoundException("Failed to create rate");

    await Promise.all([
      this.audit.recordWithDb({
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "rate",
        entityId: rate.id.toString(),
        action: "rate.created",
        after: input,
      }),
      this.cache.invalidate(CACHE_KEYS.timesheetRates(u.orgId)),
    ]);

    return rate;
  }

  async updateRate(u: CurrentUserContext, rateId: number, input: UpdateRateInput) {
    const [existing] = await this.db
      .select()
      .from(timesheetRates)
      .where(and(eq(timesheetRates.id, rateId), eq(timesheetRates.orgId, u.orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Rate not found");

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.billRate !== undefined) updateData.billRate = input.billRate.toString();
    if (input.costRate !== undefined) updateData.costRate = input.costRate?.toString() ?? null;
    if (input.currency !== undefined) updateData.currency = input.currency;
    if (input.priority !== undefined) updateData.priority = input.priority;
    if (input.projectId !== undefined) updateData.projectId = input.projectId ?? null;
    if (input.userId !== undefined) updateData.userId = input.userId ?? null;
    if (input.billingType !== undefined) updateData.billingType = input.billingType;
    if (input.rateCardId !== undefined) updateData.rateCardId = input.rateCardId ?? null;
    if (input.effectiveFrom !== undefined) updateData.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) updateData.effectiveTo = input.effectiveTo;

    const [updated] = await this.db.transaction(async (tx) => {
      const [result] = await tx
        .update(timesheetRates)
        .set(updateData)
        .where(and(eq(timesheetRates.id, rateId), eq(timesheetRates.orgId, u.orgId)))
        .returning();

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "rate",
        entityId: rateId.toString(),
        action: "rate.updated",
        before: existing,
        after: updateData,
      });

      return [result];
    });

    await this.cache.invalidate(CACHE_KEYS.timesheetRates(u.orgId));

    if (!updated) throw new NotFoundException("Rate not found after update");
    return updated;
  }

  async deleteRate(u: CurrentUserContext, rateId: number) {
    const [existing] = await this.db
      .select()
      .from(timesheetRates)
      .where(and(eq(timesheetRates.id, rateId), eq(timesheetRates.orgId, u.orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Rate not found");

    await this.db.transaction(async (tx) => {
      await tx.delete(timesheetRates).where(and(eq(timesheetRates.id, rateId), eq(timesheetRates.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "rate",
        entityId: rateId.toString(),
        action: "rate.deleted",
        before: existing,
      });
    });

    await this.cache.invalidate(CACHE_KEYS.timesheetRates(u.orgId));

    return { success: true };
  }
}
