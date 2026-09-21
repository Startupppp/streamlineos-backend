import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { and, eq, isNull, desc, SQL, count, inArray } from "drizzle-orm";
import {
  decodeCursor,
  buildCursorPage,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowDefinitions,
  hrWorkflowSteps,
} from "../../../db/schema/hr/workflow-engine";
import type {
  CreateWorkflowDefinitionDto,
  UpdateWorkflowDefinitionDto,
  WorkflowDefinitionQueryDto,
} from "./dto/workflow.schemas";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";
import { HrWorkflowApproverService } from "./hr-workflow-approver.service";
import { isUniqueViolation } from "../../../common/db/postgres-error";

interface StepInput {
  stepOrder: number;
  name: string;
  approverType: (typeof hrWorkflowSteps.$inferInsert)["approverType"];
  approverValue?: string | null;
  mode?: (typeof hrWorkflowSteps.$inferInsert)["mode"];
  slaHours?: number | null;
  escalationApproverType?: (typeof hrWorkflowSteps.$inferInsert)["escalationApproverType"];
  escalationApproverValue?: string | null;
  condition?: { field: string; operator: string; value: unknown } | null;
}

@Injectable()
export class HrWorkflowDefinitionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: HrWorkflowEngineService,
    private readonly approver: HrWorkflowApproverService,
  ) {}

  async list(orgId: string, query: WorkflowDefinitionQueryDto) {
    const pos = decodeCursor(query.cursor);
    const conditions: SQL[] = [
      eq(hrWorkflowDefinitions.orgId, orgId),
      isNull(hrWorkflowDefinitions.deletedAt),
    ];

    if (query.objectType)
      conditions.push(eq(hrWorkflowDefinitions.objectType, query.objectType));
    if (query.status)
      conditions.push(eq(hrWorkflowDefinitions.status, query.status));
    if (pos)
      conditions.push(
        keysetBeforeId(
          hrWorkflowDefinitions.createdAt,
          hrWorkflowDefinitions.id,
          pos,
        ),
      );

    const rows = await this.db
      .select({
        id: hrWorkflowDefinitions.id,
        orgId: hrWorkflowDefinitions.orgId,
        objectType: hrWorkflowDefinitions.objectType,
        name: hrWorkflowDefinitions.name,
        status: hrWorkflowDefinitions.status,
        version: hrWorkflowDefinitions.version,
        isDefault: hrWorkflowDefinitions.isDefault,
        settings: hrWorkflowDefinitions.settings,
        createdAt: hrWorkflowDefinitions.createdAt,
        updatedAt: hrWorkflowDefinitions.updatedAt,
        deletedAt: hrWorkflowDefinitions.deletedAt,
      })
      .from(hrWorkflowDefinitions)
      .where(and(...conditions))
      .orderBy(
        desc(hrWorkflowDefinitions.createdAt),
        desc(hrWorkflowDefinitions.id),
      )
      .limit(query.limit + 1);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    const defIds = page.data.map((r) => r.id);
    const stepCountRows =
      defIds.length > 0
        ? await this.db
            .select({
              definitionId: hrWorkflowSteps.definitionId,
              cnt: count(),
            })
            .from(hrWorkflowSteps)
            .where(inArray(hrWorkflowSteps.definitionId, defIds))
            .groupBy(hrWorkflowSteps.definitionId)
        : [];
    const stepCountMap = Object.fromEntries(
      stepCountRows.map((r) => [r.definitionId, r.cnt]),
    );

    return {
      data: page.data.map((row) => ({
        ...row,
        stepCount: stepCountMap[row.id] ?? 0,
      })),
      pagination: page.pagination,
    };
  }

  async get(orgId: string, id: number) {
    const [definition] = await this.db
      .select()
      .from(hrWorkflowDefinitions)
      .where(
        and(
          eq(hrWorkflowDefinitions.id, id),
          eq(hrWorkflowDefinitions.orgId, orgId),
          isNull(hrWorkflowDefinitions.deletedAt),
        ),
      )
      .limit(1);

    if (!definition)
      throw new NotFoundException("Workflow definition not found");

    const steps = await this.db
      .select()
      .from(hrWorkflowSteps)
      .where(eq(hrWorkflowSteps.definitionId, id))
      .orderBy(hrWorkflowSteps.stepOrder)
      .limit(20);

    return { ...definition, steps };
  }

  async create(orgId: string, dto: CreateWorkflowDefinitionDto) {
    try {
      const [definition] = await this.db
        .insert(hrWorkflowDefinitions)
        .values({
          orgId,
          objectType: dto.objectType,
          name: dto.name,
          status: "draft",
          version: 1,
          isDefault: dto.isDefault,
          settings: dto.settings ?? {},
        })
        .returning();

      if (!definition) throw new Error("Insert failed");

      if (dto.isDefault) {
        await this.clearOtherDefaults(orgId, dto.objectType, definition.id);
      }

      await this.upsertSteps(orgId, definition.id, dto.steps);
      return this.get(orgId, definition.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "A workflow with this name and version already exists for this object type",
        );
      }
      throw err;
    }
  }

  async update(orgId: string, id: number, dto: UpdateWorkflowDefinitionDto) {
    const definition = await this.get(orgId, id);

    if (definition.status === "active") {
      throw new BadRequestException(
        "Active definitions cannot be edited. Duplicate and edit the new version.",
      );
    }

    const updates: Partial<typeof hrWorkflowDefinitions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.isDefault !== undefined) updates.isDefault = dto.isDefault;
    if (dto.settings !== undefined) updates.settings = dto.settings;

    await this.db
      .update(hrWorkflowDefinitions)
      .set(updates)
      .where(
        and(
          eq(hrWorkflowDefinitions.id, id),
          eq(hrWorkflowDefinitions.orgId, orgId),
        ),
      );

    if (dto.isDefault) {
      await this.clearOtherDefaults(orgId, definition.objectType, id);
    }

    if (dto.steps) {
      await this.upsertSteps(orgId, id, dto.steps);
    }

    return this.get(orgId, id);
  }

  async activate(orgId: string, id: number) {
    const definition = await this.get(orgId, id);
    if (definition.status === "active") return definition;

    if (definition.steps.length === 0) {
      throw new BadRequestException("Cannot activate a workflow with no steps");
    }

    await this.db
      .update(hrWorkflowDefinitions)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(hrWorkflowDefinitions.id, id),
          eq(hrWorkflowDefinitions.orgId, orgId),
        ),
      );

    return this.get(orgId, id);
  }

  async archive(orgId: string, id: number) {
    await this.get(orgId, id);
    await this.db
      .update(hrWorkflowDefinitions)
      .set({ status: "archived", isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(hrWorkflowDefinitions.id, id),
          eq(hrWorkflowDefinitions.orgId, orgId),
        ),
      );
    return this.get(orgId, id);
  }

  async duplicate(orgId: string, id: number) {
    const source = await this.get(orgId, id);

    const newName = `${source.name} (copy)`;
    const [newDef] = await this.db
      .insert(hrWorkflowDefinitions)
      .values({
        orgId,
        objectType: source.objectType,
        name: newName,
        status: "draft",
        version: source.version + 1,
        isDefault: false,
        settings: source.settings ?? {},
      })
      .returning();

    if (!newDef) throw new Error("Duplicate failed");

    await this.upsertSteps(
      orgId,
      newDef.id,
      source.steps.map(
        (s): StepInput => ({
          stepOrder: s.stepOrder,
          name: s.name,
          approverType: s.approverType,
          approverValue: s.approverValue ?? null,
          mode: s.mode,
          slaHours: s.slaHours ?? null,
          escalationApproverType: s.escalationApproverType,
          escalationApproverValue: s.escalationApproverValue ?? null,
          condition: s.condition ?? null,
        }),
      ),
    );

    return this.get(orgId, newDef.id);
  }

  async softDelete(orgId: string, id: number) {
    const definition = await this.get(orgId, id);
    if (definition.status === "active") {
      throw new BadRequestException(
        "Archive the definition before deleting it",
      );
    }
    await this.db
      .update(hrWorkflowDefinitions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(hrWorkflowDefinitions.id, id),
          eq(hrWorkflowDefinitions.orgId, orgId),
        ),
      );
  }

  async simulate(
    orgId: string,
    workflowId: number,
    input: { subjectEmployeeId: string; context?: Record<string, unknown> },
  ) {
    const definition = await this.get(orgId, workflowId);
    const steps = definition.steps.map((s) => ({
      stepOrder: s.stepOrder,
      name: s.name,
      approverType: s.approverType,
      approverValue: s.approverValue,
      mode: s.mode,
      slaHours: s.slaHours,
      escalationApproverType: s.escalationApproverType,
      escalationApproverValue: s.escalationApproverValue,
      condition: s.condition as {
        field: string;
        operator: string;
        value: unknown;
      } | null,
    }));

    const resolvedSteps = [];
    for (const step of steps) {
      const conditionPasses = this.evaluateStepCondition(
        step.condition,
        input.context ?? {},
      );
      const approvers = conditionPasses
        ? await this.approver.resolveApprovers(
            step,
            input.subjectEmployeeId,
            orgId,
          )
        : [];
      resolvedSteps.push({
        stepOrder: step.stepOrder,
        name: step.name,
        mode: step.mode,
        approverType: step.approverType,
        conditionPasses,
        resolvedApproverUserIds: approvers,
        slaHours: step.slaHours,
      });
    }

    return {
      workflowId: definition.id,
      name: definition.name,
      objectType: definition.objectType,
      status: definition.status,
      version: definition.version,
      subjectEmployeeId: input.subjectEmployeeId,
      steps: resolvedSteps,
      explanation:
        definition.status !== "active"
          ? "Definition is not active; simulation still resolves configured steps for preview"
          : "Dry-run only — no workflow instance was created",
    };
  }

  private evaluateStepCondition(
    condition:
      | { field: string; operator: string; value: unknown }
      | null
      | undefined,
    context: Record<string, unknown>,
  ): boolean {
    if (!condition) return true;
    const actual = context[condition.field];
    switch (condition.operator) {
      case "eq":
        return actual === condition.value;
      case "gt":
        return Number(actual) > Number(condition.value);
      case "lt":
        return Number(actual) < Number(condition.value);
      case "gte":
        return Number(actual) >= Number(condition.value);
      case "lte":
        return Number(actual) <= Number(condition.value);
      case "in":
        return (
          Array.isArray(condition.value) && condition.value.includes(actual)
        );
      default:
        return true;
    }
  }

  private async clearOtherDefaults(
    orgId: string,
    objectType: (typeof hrWorkflowDefinitions.$inferSelect)["objectType"],
    excludeId: number,
  ) {
    await this.db
      .update(hrWorkflowDefinitions)
      .set({ isDefault: false })
      .where(
        and(
          eq(hrWorkflowDefinitions.orgId, orgId),
          eq(hrWorkflowDefinitions.objectType, objectType),
          isNull(hrWorkflowDefinitions.deletedAt),
        ),
      );
    await this.db
      .update(hrWorkflowDefinitions)
      .set({ isDefault: true })
      .where(
        and(
          eq(hrWorkflowDefinitions.id, excludeId),
          eq(hrWorkflowDefinitions.orgId, orgId),
        ),
      );
  }

  private async upsertSteps(orgId: string, definitionId: number, steps: StepInput[]) {
    await this.db
      .delete(hrWorkflowSteps)
      .where(and(eq(hrWorkflowSteps.orgId, orgId), eq(hrWorkflowSteps.definitionId, definitionId)));

    if (steps.length > 0) {
      await this.db.insert(hrWorkflowSteps).values(
        steps.map((s) => ({
          orgId,
          definitionId,
          stepOrder: s.stepOrder,
          name: s.name,
          approverType: s.approverType,
          approverValue: s.approverValue ?? null,
          mode: s.mode ?? "serial",
          slaHours: s.slaHours ?? null,
          escalationApproverType: s.escalationApproverType ?? null,
          escalationApproverValue: s.escalationApproverValue ?? null,
          condition: s.condition ?? null,
        })),
      );
    }
  }
}
