import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrPositions, hrReorgScenarios } from "../../../../db/schema/hr/governance";
import { hrPositionStatuses } from "../../../../db/schema/hr/taxonomy";
import { HrAuditService } from "../../core/hr-audit.service";
import { assertPositionTransitionAllowed } from "./positions-workflow-utils";
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
    const { cursor, limit, status, departmentId } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrPositions.orgId, orgId), isNull(hrPositions.deletedAt)];
    if (status) conditions.push(eq(hrPositions.status, status));
    if (departmentId) conditions.push(eq(hrPositions.departmentId, departmentId));
    if (pos) conditions.push(keysetBeforeId(hrPositions.createdAt, hrPositions.id, pos));

    const rows = await this.db
      .select()
      .from(hrPositions)
      .where(and(...conditions))
      .orderBy(desc(hrPositions.createdAt), desc(hrPositions.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async listVacant(orgId: string, input: ListPositionsInput) {
    return this.list(orgId, { ...input, status: "open" });
  }

  async getById(orgId: string, positionId: number) {
    const [row] = await this.db
      .select()
      .from(hrPositions)
      .where(
        and(
          eq(hrPositions.orgId, orgId),
          eq(hrPositions.id, positionId),
          isNull(hrPositions.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Position not found");
    return row;
  }

  async create(
    orgId: string,
    userId: string,
    input: CreatePositionInput,
    ipAddress?: string,
  ) {
    await this.assertActiveStatus(orgId, input.status);

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
    if (!position) throw new Error("Position insert did not return a row");

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_position",
      entityId: String(position.id),
      action: "position.created",
      after: { title: input.title, status: input.status },
      ipAddress,
    });

    return position;
  }

  async update(
    orgId: string,
    positionId: number,
    userId: string,
    isOrgOwner: boolean,
    input: UpdatePositionInput,
    ipAddress?: string,
  ) {
    const existing = await this.getById(orgId, positionId);

    if (input.status !== undefined && input.status !== existing.status) {
      await this.assertActiveStatus(orgId, input.status);
      await assertPositionTransitionAllowed(
        this.db,
        orgId,
        existing.status,
        input.status,
        {
          isOrgOwner,
          positionFields: {
            incumbentUserId: existing.incumbentUserId,
            departmentId: existing.departmentId,
            budgetedCostCents: existing.budgetedCostCents,
            jobLevelId: existing.jobLevelId,
          },
        },
      );
    }

    const [updated] = await this.db
      .update(hrPositions)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.departmentId !== undefined && {
          departmentId: input.departmentId,
        }),
        ...(input.jobLevelId !== undefined && { jobLevelId: input.jobLevelId }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.budgetedCostCents !== undefined && {
          budgetedCostCents: input.budgetedCostCents,
        }),
        ...(input.effectiveFrom !== undefined && {
          effectiveFrom: new Date(input.effectiveFrom),
        }),
        ...(input.incumbentUserId !== undefined && {
          incumbentUserId: input.incumbentUserId,
        }),
        ...(input.futureDated !== undefined && { futureDated: input.futureDated }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId)))
      .returning();
    if (!updated) throw new Error("Position update did not return a row");

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

    return updated;
  }

  async softDelete(
    orgId: string,
    positionId: number,
    userId: string,
    ipAddress?: string,
  ) {
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

  async assignEmployee(
    orgId: string,
    positionId: number,
    userId: string,
    isOrgOwner: boolean,
    input: AssignPositionInput,
    ipAddress?: string,
  ) {
    const existing = await this.getById(orgId, positionId);

    await this.assertActiveStatus(orgId, "filled");
    await assertPositionTransitionAllowed(
      this.db,
      orgId,
      existing.status,
      "filled",
      {
        isOrgOwner,
        positionFields: {
          incumbentUserId: existing.incumbentUserId,
          departmentId: existing.departmentId,
          budgetedCostCents: existing.budgetedCostCents,
          jobLevelId: existing.jobLevelId,
        },
      },
    );

    const [updated] = await this.db
      .update(hrPositions)
      .set({
        incumbentUserId: input.incumbentUserId,
        status: "filled",
        updatedAt: new Date(),
      })
      .where(and(eq(hrPositions.orgId, orgId), eq(hrPositions.id, positionId)))
      .returning();
    if (!updated) throw new Error("Position assign update did not return a row");

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

    return updated;
  }

  async listScenarios(orgId: string, input: ListScenariosInput) {
    const { cursor, limit, status } = input;
    const pos = decodeCursor(cursor);

    const conditions = [
      eq(hrReorgScenarios.orgId, orgId),
      isNull(hrReorgScenarios.deletedAt),
    ];
    if (status) conditions.push(eq(hrReorgScenarios.status, status));
    if (pos) conditions.push(keysetBeforeId(hrReorgScenarios.createdAt, hrReorgScenarios.id, pos));

    const rows = await this.db
      .select()
      .from(hrReorgScenarios)
      .where(and(...conditions))
      .orderBy(desc(hrReorgScenarios.createdAt), desc(hrReorgScenarios.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createScenario(
    orgId: string,
    userId: string,
    input: CreateReorgScenarioInput,
    ipAddress?: string,
  ) {
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
    if (!scenario) throw new Error("Reorg scenario insert did not return a row");

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_reorg_scenario",
      entityId: String(scenario.id),
      action: "reorg_scenario.created",
      after: { name: input.name },
      ipAddress,
    });

    return scenario;
  }

  async updateScenario(
    orgId: string,
    scenarioId: number,
    userId: string,
    input: UpdateReorgScenarioInput,
    ipAddress?: string,
  ) {
    const existing = await this.getScenarioById(orgId, scenarioId);

    const [updated] = await this.db
      .update(hrReorgScenarios)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.changes !== undefined && { changes: input.changes }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrReorgScenarios.orgId, orgId),
          eq(hrReorgScenarios.id, scenarioId),
        ),
      )
      .returning();
    if (!updated) throw new Error("Reorg scenario update did not return a row");

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

    return updated;
  }

  async deleteScenario(
    orgId: string,
    scenarioId: number,
    userId: string,
    ipAddress?: string,
  ) {
    await this.getScenarioById(orgId, scenarioId);

    await this.db
      .update(hrReorgScenarios)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(hrReorgScenarios.orgId, orgId),
          eq(hrReorgScenarios.id, scenarioId),
        ),
      );

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

    const changes = scenario.changes;

    const positionMovesRaw = changes["positionMoves"];
    const positionMoves = Array.isArray(positionMovesRaw) ? positionMovesRaw : [];
    const reportingMovesRaw = changes["reportingMoves"];
    const reportingMoves = Array.isArray(reportingMovesRaw) ? reportingMovesRaw : [];

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
      warning:
        "This is a simulation only. Current org structure is NOT affected until the scenario is applied.",
    };
  }

  private async assertActiveStatus(
    orgId: string,
    statusName: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: hrPositionStatuses.id })
      .from(hrPositionStatuses)
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.name, statusName),
          eq(hrPositionStatuses.isActive, true),
        ),
      )
      .limit(1);
    if (!row)
      throw new BadRequestException(
        `Status '${statusName}' is not a valid active status for this organisation.`,
      );
  }

  private async getScenarioById(orgId: string, scenarioId: number) {
    const [row] = await this.db
      .select()
      .from(hrReorgScenarios)
      .where(
        and(
          eq(hrReorgScenarios.orgId, orgId),
          eq(hrReorgScenarios.id, scenarioId),
          isNull(hrReorgScenarios.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Reorg scenario not found");
    return row;
  }
}
