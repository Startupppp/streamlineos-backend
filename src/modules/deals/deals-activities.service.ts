import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { deals, dealActivities, dealStageTransitions, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { ActivitiesService } from "../activities/activities.service";
import { activityKindFor, subjectFor } from "./deal-activity-kind";
import type { LogActivityInput, PatchCustomDataInput } from "./dto/deals.schemas";

@Injectable()
export class DealsActivitiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activities: ActivitiesService,
  ) {}

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

  /**
   * Reads the table `addActivity` writes to.
   *
   * It did not. `addActivity` moved to the one activity model so a call logged
   * against a deal reaches the same timeline as a call logged against a party,
   * but this read stayed on `deal_activities` — so a rep logged a call, got a
   * 201, and the deal's activity list did not contain it. What the list did show
   * was the stage-change rows `deals.service` still writes to the old table,
   * which made it look populated and working.
   *
   * Both are read during the migration, newest first across the two. The legacy
   * half goes when the stage-change writer moves, and the union goes with it.
   */
  async listActivities(orgId: string, dealId: number) {
    const [current, legacy] = await Promise.all([
      this.activities.timeline(orgId, { dealId, limit: 50 }),
      this.db
        .select()
        .from(dealActivities)
        .where(and(eq(dealActivities.dealId, dealId), eq(dealActivities.orgId, orgId)))
        .orderBy(desc(dealActivities.createdAt))
        .limit(50),
    ]);

    const merged = [
      ...current.data.map((item) => ({
        activityId: item.activityId,
        kind: item.kind,
        subject: item.subject,
        body: item.body,
        occurredAt: item.occurredAt,
        source: "activities" as const,
      })),
      ...legacy.map((row) => ({
        activityId: String(row.id),
        kind: row.type,
        subject: row.subject,
        body: row.notes,
        occurredAt: row.createdAt,
        source: "deal_activities" as const,
      })),
    ];

    return merged
      .sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0))
      .slice(0, 50);
  }

  /**
   * A call, email, meeting or note logged against a deal.
   *
   * Written to the one activity model rather than to `deal_activities`, so the
   * deal's timeline is the same surface as a party's and a subject's. Ticket 09
   * exists because a call was recorded differently depending on which module the
   * record entered through; leaving this write on the deal-only table would have
   * kept exactly that.
   *
   * `lastContactDate` still moves, because the pipeline reads it.
   */
  async addActivity(orgId: string, userId: string, dealId: number, input: LogActivityInput) {
    const [deal] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
    if (!deal) throw new NotFoundException("Deal not found");

    const kind = activityKindFor(input.type);
    if (!kind)
      throw new BadRequestException({
        code: "NOT_AN_ACTIVITY",
        message: `"${input.type}" is not something the timeline records.`,
      });

    const activity = await this.activities.create(
      orgId,
      { kind: "human", userId },
      {
        kind,
        dealId,
        subject: subjectFor(input.type, input.subject) ?? undefined,
        body: input.notes ?? undefined,
        participants: [],
      },
    );

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
