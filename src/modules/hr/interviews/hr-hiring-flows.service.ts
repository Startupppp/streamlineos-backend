import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, max } from "drizzle-orm";
import { hiringFlowRounds, hiringFlows } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  CreateHiringFlowInput,
  CreateRoundInput,
  UpdateHiringFlowInput,
  UpdateRoundInput,
} from "./dto/hr-interviews.schemas";

@Injectable()
export class HrHiringFlowsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listFlows(orgId: string, limit: number, offset: number) {
    return this.cache.cachedVersioned(
      `hr:hiring-flows:${orgId}`,
      `list:${limit}:${offset}`,
      () =>
        this.db.query.hiringFlows.findMany({
          where: eq(hiringFlows.orgId, orgId),
          orderBy: [desc(hiringFlows.isDefault), desc(hiringFlows.createdAt)],
          limit,
          offset,
          with: { rounds: { orderBy: (r, { asc }) => [asc(r.orderIndex)] } },
        }),
      CACHE_TTL.SHORT,
    );
  }

  async createFlow(orgId: string, userId: string, input: CreateHiringFlowInput) {
    if (input.isDefault) {
      await this.db
        .update(hiringFlows)
        .set({ isDefault: false })
        .where(and(eq(hiringFlows.orgId, orgId), eq(hiringFlows.isDefault, true)));
    }

    const [flow] = await this.db
      .insert(hiringFlows)
      .values({
        orgId,
        name: input.name.trim(),
        isDefault: input.isDefault ?? false,
        createdBy: userId,
      })
      .returning();

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return flow;
  }

  async getFlow(orgId: string, id: number) {
    const flow = await this.cache.cachedVersioned(
      `hr:hiring-flows:${orgId}`,
      `detail:${id}`,
      () =>
        this.db.query.hiringFlows.findFirst({
          where: and(eq(hiringFlows.id, id), eq(hiringFlows.orgId, orgId)),
          with: { rounds: { orderBy: (r, { asc }) => [asc(r.orderIndex)] } },
        }),
      CACHE_TTL.SHORT,
    );
    if (!flow) throw new NotFoundException("Hiring flow not found");
    return flow;
  }

  async updateFlow(orgId: string, id: number, input: UpdateHiringFlowInput) {
    const existing = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, id), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Hiring flow not found");

    if (input.isDefault) {
      await this.db
        .update(hiringFlows)
        .set({ isDefault: false })
        .where(and(eq(hiringFlows.orgId, orgId), eq(hiringFlows.isDefault, true)));
    }

    const [updated] = await this.db
      .update(hiringFlows)
      .set({
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      })
      .where(and(eq(hiringFlows.id, id), eq(hiringFlows.orgId, orgId)))
      .returning();

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return updated;
  }

  async deleteFlow(orgId: string, id: number) {
    const existing = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, id), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Hiring flow not found");

    await this.db.delete(hiringFlows).where(and(eq(hiringFlows.id, id), eq(hiringFlows.orgId, orgId)));

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return { success: true };
  }

  async listRounds(orgId: string, flowId: number) {
    const flow = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, flowId), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!flow) throw new NotFoundException("Hiring flow not found");

    return this.db.query.hiringFlowRounds.findMany({
      limit: 100,
      where: eq(hiringFlowRounds.flowId, flowId),
      orderBy: (r, { asc }) => [asc(r.orderIndex)],
    });
  }

  async createRound(orgId: string, flowId: number, input: CreateRoundInput) {
    const flow = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, flowId), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!flow) throw new NotFoundException("Hiring flow not found");

    const maxResult = await this.db
      .select({ maxOrder: max(hiringFlowRounds.orderIndex) })
      .from(hiringFlowRounds)
      .where(eq(hiringFlowRounds.flowId, flowId));

    const nextOrder = (maxResult[0]?.maxOrder ?? -1) + 1;

    const [round] = await this.db
      .insert(hiringFlowRounds)
      .values({
        flowId,
        orgId,
        name: input.name.trim(),
        roundType: input.roundType,
        mode: input.mode,
        durationMinutes: input.durationMinutes,
        slaDays: input.slaDays,
        questionBankTag: input.questionBankTag,
        scorecardTemplateId: input.scorecardTemplateId,
        interviewerRoleRestriction: input.interviewerRoleRestriction,
        autoAdvanceThreshold: input.autoAdvanceThreshold,
        orderIndex: nextOrder,
      })
      .returning();

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return round;
  }

  async updateRound(orgId: string, flowId: number, roundId: number, input: UpdateRoundInput) {
    const flow = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, flowId), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!flow) throw new NotFoundException("Hiring flow not found");

    const existing = await this.db.query.hiringFlowRounds.findFirst({
      where: and(eq(hiringFlowRounds.id, roundId), eq(hiringFlowRounds.flowId, flowId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Round not found");

    const [updated] = await this.db
      .update(hiringFlowRounds)
      .set({
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.roundType !== undefined && { roundType: input.roundType }),
        ...(input.mode !== undefined && { mode: input.mode }),
        ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }),
        ...(input.slaDays !== undefined && { slaDays: input.slaDays }),
        ...(input.questionBankTag !== undefined && { questionBankTag: input.questionBankTag }),
        ...(input.scorecardTemplateId !== undefined && { scorecardTemplateId: input.scorecardTemplateId }),
        ...(input.interviewerRoleRestriction !== undefined && {
          interviewerRoleRestriction: input.interviewerRoleRestriction,
        }),
        ...(input.autoAdvanceThreshold !== undefined && { autoAdvanceThreshold: input.autoAdvanceThreshold }),
        ...(input.orderIndex !== undefined && { orderIndex: input.orderIndex }),
      })
      .where(and(eq(hiringFlowRounds.id, roundId), eq(hiringFlowRounds.flowId, flowId)))
      .returning();

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return updated;
  }

  async deleteRound(orgId: string, flowId: number, roundId: number) {
    const flow = await this.db.query.hiringFlows.findFirst({
      where: and(eq(hiringFlows.id, flowId), eq(hiringFlows.orgId, orgId)),
      columns: { id: true },
    });
    if (!flow) throw new NotFoundException("Hiring flow not found");

    await this.db
      .delete(hiringFlowRounds)
      .where(and(eq(hiringFlowRounds.id, roundId), eq(hiringFlowRounds.flowId, flowId)));

    await this.cache.invalidateNamespace(`hr:hiring-flows:${orgId}`);
    return { success: true };
  }
}
