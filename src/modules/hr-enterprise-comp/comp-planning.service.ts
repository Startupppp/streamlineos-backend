import { Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  hrCompCycles,
  hrCompRecommendations,
  hrCompBudgetPools,
} from "../../db/schema/hr/enterprise-comp";
import { HrAuditService } from "../hr-core/hr-audit.service";
import { HrEffectiveChangesService } from "../hr-core/hr-effective-changes.service";
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

@Injectable()
export class CompPlanningService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly effectiveChanges: HrEffectiveChangesService,
  ) {}

  async createCycle(orgId: string, actorId: string, input: CreateCompCycleInput) {
    const [created] = await this.db.insert(hrCompCycles).values({ orgId, ...input, meritMatrix: input.meritMatrix ?? null, createdBy: actorId }).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_cycles", entityId: String(created!.id), action: "created", after: created });
    return created;
  }

  async listCycles(orgId: string, input: ListCompCyclesInput) {
    const { page, limit, status, fiscalYear } = input;
    const offset = (page - 1) * limit;
    const conditions = [eq(hrCompCycles.orgId, orgId)];
    if (status) conditions.push(eq(hrCompCycles.status, status));
    if (fiscalYear) conditions.push(eq(hrCompCycles.fiscalYear, fiscalYear));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrCompCycles).where(where).orderBy(desc(hrCompCycles.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(hrCompCycles).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getCycle(orgId: string, cycleId: number) {
    const [cycle] = await this.db.select().from(hrCompCycles).where(and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId))).limit(1);
    if (!cycle) throw new NotFoundException("Compensation cycle not found");
    return cycle;
  }

  async updateCycle(orgId: string, cycleId: number, actorId: string, input: UpdateCompCycleInput) {
    const [updated] = await this.db
      .update(hrCompCycles)
      .set({ ...input, meritMatrix: (input.meritMatrix ?? undefined) as never, updatedAt: new Date() })
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

    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(created!.id), action: "created", after: created });
    return created;
  }

  async listRecommendations(orgId: string, input: ListRecommendationsInput) {
    const { page, limit, cycleId, userId, status } = input;
    const offset = (page - 1) * limit;
    const conditions = [eq(hrCompRecommendations.orgId, orgId)];
    if (cycleId) conditions.push(eq(hrCompRecommendations.cycleId, cycleId));
    if (userId) conditions.push(eq(hrCompRecommendations.userId, userId));
    if (status) conditions.push(eq(hrCompRecommendations.status, status));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrCompRecommendations).where(where).orderBy(desc(hrCompRecommendations.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(hrCompRecommendations).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async updateRecommendation(orgId: string, recId: number, actorId: string, input: UpdateRecommendationInput) {
    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.recommendedIncreaseCents !== undefined) setData["recommendedIncreaseCents"] = input.recommendedIncreaseCents;
    if (input.recommendedPct !== undefined) setData["recommendedPct"] = String(input.recommendedPct);
    if (input.rating !== undefined) setData["rating"] = input.rating;
    if (input.managerNote !== undefined) setData["managerNote"] = input.managerNote;

    const [updated] = await this.db
      .update(hrCompRecommendations)
      .set(setData as never)
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
    const [existing] = await this.db.select().from(hrCompRecommendations).where(and(eq(hrCompRecommendations.id, recId), eq(hrCompRecommendations.orgId, orgId))).limit(1);
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
        oldValue: { salaryCents: existing.currentSalaryCents },
        newValue: { salaryCents: existing.currentSalaryCents + Number(finalCents) },
        effectiveFrom: input.effectiveFrom,
        notes: `Comp cycle approval: +${finalCents} cents`,
      });
    });

    await this.audit.log({ orgId, actorId, entityType: "hr_comp_recommendations", entityId: String(recId), action: "approved", after: { finalCents } });
    return { approved: true, finalCents };
  }

  async getBudgetPools(orgId: string, cycleId: number) {
    return this.db
      .select()
      .from(hrCompBudgetPools)
      .where(and(eq(hrCompBudgetPools.orgId, orgId), eq(hrCompBudgetPools.cycleId, cycleId)))
      .limit(100);
  }

  async createBudgetPool(orgId: string, actorId: string, input: CreateBudgetPoolInput) {
    const [created] = await this.db.insert(hrCompBudgetPools).values({ orgId, ...input }).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_comp_budget_pools", entityId: String(created!.id), action: "created", after: created });
    return created;
  }
}
