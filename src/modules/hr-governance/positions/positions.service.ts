import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrPositions, hrReorgScenarios } from "../../../db/schema/hr/governance";
import { HrAuditService } from "../../hr-core/hr-audit.service";
import type {
  CreatePositionInput,
  UpdatePositionInput,
  ListPositionsInput,
  AssignPositionInput,
  CreateReorgScenarioInput,
  UpdateReorgScenarioInput,
  ListScenariosInput,
} from "./positions.dto";

@Injectable()
export class PositionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, input: ListPositionsInput) {
    const { page, limit, status, departmentId } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrPositions.orgId, orgId), isNull(hrPositions.deletedAt)];
    if (status) conditions.push(eq(hrPositions.status, status));
    if (departmentId) conditions.push(eq(hrPositions.departmentId, departmentId));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrPositions)
        .where(where)
        .orderBy(desc(hrPositions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrPositions).where(where),
    ]);

    return { data, total: totalResult[0]?.total ?? 0, page, limit };
  }

  async listVacant(orgId: string, input: ListPositionsInput) {
    return this.list(orgId, { ...input, status: "open" });
  }

  async getById(orgId: string, positionId: number) {
    const [row] = await this.db
      .select()
      .from(hrPositions)
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId), isNull(hrPositions.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException("Position not found");
    return row;
  }

  async create(orgId: string, userId: string, input: CreatePositionInput, ipAddress?: string) {
    const [position] = await this.db
      .insert(hrPositions)
      .values({
        orgId,
        title: input.title,
        departmentId: input.departmentId ?? null,
        jobLevelId: input.jobLevelId ?? null,
        status: input.status,
        budgetedCostCents: input.budgetedCostCents ?? null,
        effectiveFrom: new Date(input.effectiveFrom),
        incumbentUserId: input.incumbentUserId ?? null,
        futureDated: input.futureDated ?? false,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_position",
      entityId: String(position!.id),
      action: "position.created",
      after: { title: input.title, status: input.status },
      ipAddress,
    });

    return position!;
  }

  async update(orgId: string, positionId: number, userId: string, input: UpdatePositionInput, ipAddress?: string) {
    const existing = await this.getById(orgId, positionId);

    const [updated] = await this.db
      .update(hrPositions)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.departmentId !== undefined && { departmentId: input.departmentId }),
        ...(input.jobLevelId !== undefined && { jobLevelId: input.jobLevelId }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.budgetedCostCents !== undefined && { budgetedCostCents: input.budgetedCostCents }),
        ...(input.effectiveFrom !== undefined && { effectiveFrom: new Date(input.effectiveFrom) }),
        ...(input.incumbentUserId !== undefined && { incumbentUserId: input.incumbentUserId }),
        ...(input.futureDated !== undefined && { futureDated: input.futureDated }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_position",
      entityId: String(positionId),
      action: "position.updated",
      before: { title: existing.title, status: existing.status },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async softDelete(orgId: string, positionId: number, userId: string, ipAddress?: string) {
    await this.getById(orgId, positionId);

    await this.db
      .update(hrPositions)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_position",
      entityId: String(positionId),
      action: "position.deleted",
      ipAddress,
    });
  }

  async assignEmployee(orgId: string, positionId: number, userId: string, input: AssignPositionInput, ipAddress?: string) {
    const existing = await this.getById(orgId, positionId);

    const [updated] = await this.db
      .update(hrPositions)
      .set({ incumbentUserId: input.incumbentUserId, status: "filled", updatedAt: new Date() })
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_position",
      entityId: String(positionId),
      action: "position.assigned",
      before: { incumbentUserId: existing.incumbentUserId },
      after: { incumbentUserId: input.incumbentUserId },
      ipAddress,
    });

    return updated!;
  }

  async listScenarios(orgId: string, input: ListScenariosInput) {
    const { page, limit, status } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrReorgScenarios.orgId, orgId), isNull(hrReorgScenarios.deletedAt)];
    if (status) conditions.push(eq(hrReorgScenarios.status, status));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrReorgScenarios)
        .where(where)
        .orderBy(desc(hrReorgScenarios.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrReorgScenarios).where(where),
    ]);

    return { data, total: totalResult[0]?.total ?? 0, page, limit };
  }

  async createScenario(orgId: string, userId: string, input: CreateReorgScenarioInput, ipAddress?: string) {
    const [scenario] = await this.db
      .insert(hrReorgScenarios)
      .values({
        orgId,
        name: input.name,
        status: "draft",
        changes: input.changes,
        createdBy: userId,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_reorg_scenario",
      entityId: String(scenario!.id),
      action: "reorg_scenario.created",
      after: { name: input.name },
      ipAddress,
    });

    return scenario!;
  }

  async updateScenario(orgId: string, scenarioId: number, userId: string, input: UpdateReorgScenarioInput, ipAddress?: string) {
    const existing = await this.getScenarioById(orgId, scenarioId);

    const [updated] = await this.db
      .update(hrReorgScenarios)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.changes !== undefined && { changes: input.changes }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrReorgScenarios.orgId, orgId), eq(hrReorgScenarios.id, scenarioId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_reorg_scenario",
      entityId: String(scenarioId),
      action: "reorg_scenario.updated",
      before: { name: existing.name, status: existing.status },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async deleteScenario(orgId: string, scenarioId: number, userId: string, ipAddress?: string) {
    await this.getScenarioById(orgId, scenarioId);

    await this.db
      .update(hrReorgScenarios)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrReorgScenarios.orgId, orgId), eq(hrReorgScenarios.id, scenarioId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_reorg_scenario",
      entityId: String(scenarioId),
      action: "reorg_scenario.deleted",
      ipAddress,
    });
  }

  async simulateScenario(orgId: string, scenarioId: number) {
    const scenario = await this.getScenarioById(orgId, scenarioId);

    const changes = scenario.changes as Record<string, unknown>;

    const positionMoves = (changes["positionMoves"] as unknown[]) ?? [];
    const reportingMoves = (changes["reportingMoves"] as unknown[]) ?? [];

    return {
      scenarioId,
      scenarioName: scenario.name,
      status: scenario.status,
      projectedEffect: {
        affectedPositions: positionMoves.length,
        affectedReportingLines: reportingMoves.length,
        positionMoves,
        reportingMoves,
      },
      warning: "This is a simulation only. Current org structure is NOT affected until the scenario is applied.",
    };
  }

  private async getScenarioById(orgId: string, scenarioId: number) {
    const [row] = await this.db
      .select()
      .from(hrReorgScenarios)
      .where(and(eq(hrReorgScenarios.orgId, orgId), eq(hrReorgScenarios.id, scenarioId), isNull(hrReorgScenarios.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException("Reorg scenario not found");
    return row;
  }
}
