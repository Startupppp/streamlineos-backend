import { Inject, Injectable, InternalServerErrorException, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrCompCycles,
  hrCompRecommendations,
  hrCompBudgetPools,
} from "../../../db/schema/hr/enterprise-comp";
import { HrAuditService } from "../core/hr-audit.service";
import { HrEffectiveChangesService } from "../core/hr-effective-changes.service";
import type {
  CreateCompCycleInput,
  UpdateCompCycleInput,
  ListCompCyclesInput,
  CreateRecommendationInput,
  UpdateRecommendationInput,
  CalibrateRecommendationInput,
  ListRecommendationsInput,
  ApproveRecommendationInput,
  CreateBudgetPoolInput,
} from "./dto/enterprise-comp.schemas";

function decodePaginationCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const position = decodeCursor(cursor);
  if (!position) throw new BadRequestException("Invalid pagination cursor");
  return position;
}

@Injectable()
export class CompPlanningService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly effectiveChanges: HrEffectiveChangesService,
  ) {}

  async createCycle(orgId: string, actorId: string, input: CreateCompCycleInput) {
    const [created] = await this.db.insert(hrCompCycles).values({ orgId, ...input, meritMatrix: input.meritMatrix ?? null, createdBy: actorId }).returning();
    if (!created) throw new InternalServerErrorException("Failed to create compensation cycle");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_cycles", entityId: String(created.id), action: "created", after: created });
    return created;
  }

  async listCycles(orgId: string, input: ListCompCyclesInput) {
    const { cursor, limit, status, fiscalYear } = input;
    const conditions = [eq(hrCompCycles.orgId, orgId)];
    if (status) conditions.push(eq(hrCompCycles.status, status));
    if (fiscalYear) conditions.push(eq(hrCompCycles.fiscalYear, fiscalYear));
    const position = decodePaginationCursor(cursor);
    if (position)
      conditions.push(keysetBeforeId(hrCompCycles.createdAt, hrCompCycles.id, position));

    const rows = await this.db
      .select()
      .from(hrCompCycles)
      .where(and(...conditions))
      .orderBy(desc(hrCompCycles.createdAt), desc(hrCompCycles.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (cycle) => ({
      sortValue: cycle.createdAt.toISOString(),
      id: String(cycle.id),
    }));
  }

  async getCycle(orgId: string, cycleId: number) {
    const [cycle] = await this.db.select().from(hrCompCycles).where(and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId))).limit(1);
    if (!cycle) throw new NotFoundException("Compensation cycle not found");
    return cycle;
  }

  async updateCycle(orgId: string, cycleId: number, actorId: string, input: UpdateCompCycleInput) {
    const [updated] = await this.db
      .update(hrCompCycles)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Compensation cycle not found");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_cycles", entityId: String(cycleId), action: "updated", after: updated });
    return updated;
  }

  async createRecommendation(orgId: string, actorId: string, input: CreateRecommendationInput) {
    const [cycle] = await this.db.select({ id: hrCompCycles.id, status: hrCompCycles.status }).from(hrCompCycles).where(and(eq(hrCompCycles.id, input.cycleId), eq(hrCompCycles.orgId, orgId))).limit(1);
    if (!cycle) throw new NotFoundException("Compensation cycle not found");
    if (cycle.status === "approved" || cycle.status === "closed") {
      throw new BadRequestException("Cycle is not open for recommendations");
    }

    const [created] = await this.db.insert(hrCompRecommendations).values({
      orgId,
      cycleId: input.cycleId,
      userId: input.userId,
      currentSalaryCents: input.currentSalaryCents,
      recommendedIncreaseCents: input.recommendedIncreaseCents,
      recommendedPct: String(input.recommendedPct),
      rating: input.rating ?? null,
      managerNote: input.managerNote ?? null,
    }).returning();

    if (!created) throw new InternalServerErrorException("Failed to create compensation recommendation");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(created.id), action: "created", after: created });
    return created;
  }

  async listRecommendations(orgId: string, input: ListRecommendationsInput) {
    const { cursor, limit, cycleId, userId, status } = input;
    const conditions = [eq(hrCompRecommendations.orgId, orgId)];
    if (cycleId) conditions.push(eq(hrCompRecommendations.cycleId, cycleId));
    if (userId) conditions.push(eq(hrCompRecommendations.userId, userId));
    if (status) conditions.push(eq(hrCompRecommendations.status, status));
    const position = decodePaginationCursor(cursor);
    if (position)
      conditions.push(
        keysetBeforeId(hrCompRecommendations.createdAt, hrCompRecommendations.id, position),
      );

    const rows = await this.db
      .select({
        id: hrCompRecommendations.id,
        cycleId: hrCompRecommendations.cycleId,
        userId: hrCompRecommendations.userId,
        currentSalaryCents: hrCompRecommendations.currentSalaryCents,
        recommendedIncreaseCents: hrCompRecommendations.recommendedIncreaseCents,
        recommendedPct: hrCompRecommendations.recommendedPct,
        rating: hrCompRecommendations.rating,
        managerNote: hrCompRecommendations.managerNote,
        hrCalibratedCents: hrCompRecommendations.hrCalibratedCents,
        status: hrCompRecommendations.status,
        createdAt: hrCompRecommendations.createdAt,
      })
      .from(hrCompRecommendations)
      .where(and(...conditions))
      .orderBy(desc(hrCompRecommendations.createdAt), desc(hrCompRecommendations.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (recommendation) => ({
      sortValue: recommendation.createdAt.toISOString(),
      id: String(recommendation.id),
    }));
  }

  async updateRecommendation(orgId: string, recId: number, actorId: string, input: UpdateRecommendationInput) {
    const [updated] = await this.db
      .update(hrCompRecommendations)
      .set({
        updatedAt: new Date(),
        ...(input.recommendedIncreaseCents !== undefined && { recommendedIncreaseCents: input.recommendedIncreaseCents }),
        ...(input.recommendedPct !== undefined && { recommendedPct: String(input.recommendedPct) }),
        ...(input.rating !== undefined && { rating: input.rating }),
        ...(input.managerNote !== undefined && { managerNote: input.managerNote }),
      })
      .where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Recommendation not found");
    return updated;
  }

  async submitRecommendation(orgId: string, recId: number, actorId: string) {
    const [updated] = await this.db
      .update(hrCompRecommendations)
      .set({ status: "submitted", submittedBy: actorId, updatedAt: new Date() })
      .where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Recommendation not found");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(recId), action: "submitted" });
    return updated;
  }

  async calibrateRecommendation(orgId: string, recId: number, actorId: string, input: CalibrateRecommendationInput) {
    const [updated] = await this.db
      .update(hrCompRecommendations)
      .set({ status: "calibrated", hrCalibratedCents: input.hrCalibratedCents, calibratedBy: actorId, updatedAt: new Date() })
      .where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Recommendation not found");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(recId), action: "calibrated", after: { hrCalibratedCents: input.hrCalibratedCents } });
    return updated;
  }

  async approveRecommendation(orgId: string, recId: number, actorId: string, input: ApproveRecommendationInput) {
    const [existing] = await this.db.select({
      id: hrCompRecommendations.id,
      cycleId: hrCompRecommendations.cycleId,
      currentSalaryCents: hrCompRecommendations.currentSalaryCents,
      recommendedIncreaseCents: hrCompRecommendations.recommendedIncreaseCents,
      hrCalibratedCents: hrCompRecommendations.hrCalibratedCents,
    }).from(hrCompRecommendations).where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId))).limit(1);
    if (!existing) throw new NotFoundException("Recommendation not found");

    const finalCents = existing.hrCalibratedCents ?? existing.recommendedIncreaseCents;

    await this.db.transaction(async (tx) => {
      await tx.update(hrCompRecommendations).set({ status: "approved", approvedBy: actorId, updatedAt: new Date() }).where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId)));

      await tx.update(hrCompBudgetPools).set({ usedCents: sql`used_cents + ${finalCents}` }).where(and(
        eq(hrCompBudgetPools.orgId, orgId),
        eq(hrCompBudgetPools.cycleId, existing.cycleId),
        isNull(hrCompBudgetPools.departmentId),
      ));

      await this.effectiveChanges.create(orgId, actorId, {
        employmentId: input.employmentId,
        changeType: "compensation",
        newValue: { salaryCents: existing.currentSalaryCents + Number(finalCents) },
        effectiveFrom: input.effectiveFrom,
        notes: `Comp cycle approval: +${finalCents} cents`,
      }, tx);
    });

    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(recId), action: "approved", after: { finalCents } });
    return { approved: true, finalCents };
  }

  /**
   * The cycle named in the path, resolved under the caller's organisation.
   *
   * `getBudgetPools` did this and `createBudgetPool` did not, so a cross-tenant `:cycleId` reached
   * the INSERT and the composite tenant FK refused it with an uncaught 23503 — a **500** where the
   * contract requires 404, measured by the live cross-tenant sweep (control 201, cross-tenant 500).
   */
  private async assertCycleInOrg(orgId: string, cycleId: number): Promise<void> {
    const cycle = await this.db.query.hrCompCycles.findFirst({
      columns: { id: true },
      where: and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId)),
    });
    if (!cycle) throw new NotFoundException("Compensation cycle not found");
  }

  async getBudgetPools(orgId: string, cycleId: number) {
    await this.assertCycleInOrg(orgId, cycleId);
    return this.db
      .select()
      .from(hrCompBudgetPools)
      .where(and(eq(hrCompBudgetPools.orgId, orgId), eq(hrCompBudgetPools.cycleId, cycleId)))
      .limit(100);
  }

  async createBudgetPool(orgId: string, actorId: string, input: CreateBudgetPoolInput) {
    await this.assertCycleInOrg(orgId, input.cycleId);
    const [created] = await this.db.insert(hrCompBudgetPools).values({ orgId, ...input }).returning();
    if (!created) throw new InternalServerErrorException("Failed to create budget pool");
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_budget_pools", entityId: String(created.id), action: "created", after: created });
    return created;
  }
}
