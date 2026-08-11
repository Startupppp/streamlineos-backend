import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { deals, dealActivities } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { LogActivityInput, PatchCustomDataInput } from "./dto/deals.schemas";

@Injectable()
export class DealsActivitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
