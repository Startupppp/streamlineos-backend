import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { deals, dealActivities, dealStageTransitions, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { LogActivityInput, PatchCustomDataInput } from "./dto/deals.schemas";

@Injectable()
export class DealsActivitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Every move this deal made, and what moved it.
   *
   * Separate from `listActivities` on purpose: that is a display log a person
   * reads, this is the accountable record a reviewer audits, and ticket 13's
   * review feed will read the same rows. The actor's name is resolved here so no
   * caller is left rendering an identifier.
   */
  listStageTransitions(orgId: string, dealId: number) {
    return this.db
      .select({
        dealStageTransitionId: dealStageTransitions.dealStageTransitionId,
        fromStage: dealStageTransitions.fromStage,
        toStage: dealStageTransitions.toStage,
        actorKind: dealStageTransitions.actorKind,
        actorLabel: dealStageTransitions.actorLabel,
        actorName: users.name,
        reason: dealStageTransitions.reason,
        occurredAt: dealStageTransitions.occurredAt,
      })
      .from(dealStageTransitions)
      .leftJoin(users, eq(users.id, dealStageTransitions.actorUserId))
      .where(
        and(
          eq(dealStageTransitions.organizationId, orgId),
          eq(dealStageTransitions.dealId, dealId),
        ),
      )
      .orderBy(desc(dealStageTransitions.occurredAt))
      .limit(100);
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
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
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
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));

    return activity;
  }

  async updateCustomData(orgId: string, dealId: number, input: PatchCustomDataInput) {
    const [existing] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
      .limit(1);
    if (!existing) throw new NotFoundException("Deal not found");

    const [updated] = await this.db
      .update(deals)
      .set({ customData: input.customData, updatedAt: new Date() })
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
      .returning();

    return { customData: updated.customData };
  }
}
