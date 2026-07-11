import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, isNull, desc, SQL, count } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrWorkflowDefinitions, hrWorkflowSteps } from "../../db/schema/hr/workflow-engine";
import type { CreateWorkflowDefinitionDto, UpdateWorkflowDefinitionDto, WorkflowDefinitionQueryDto } from "./dto/workflow.schemas";

interface StepInput {
  stepOrder: number;
  name: string;
  approverType: typeof hrWorkflowSteps.$inferInsert["approverType"];
  approverValue?: string | null;
  mode?: typeof hrWorkflowSteps.$inferInsert["mode"];
  slaHours?: number | null;
  escalationApproverType?: typeof hrWorkflowSteps.$inferInsert["escalationApproverType"];
  escalationApproverValue?: string | null;
  condition?: { field: string; operator: string; value: unknown } | null;
}

@Injectable()
export class HrWorkflowDefinitionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: WorkflowDefinitionQueryDto) {
    const conditions: SQL[] = [
      eq(hrWorkflowDefinitions.orgId, orgId),
      isNull(hrWorkflowDefinitions.deletedAt),
    ];

    if (query.objectType) conditions.push(eq(hrWorkflowDefinitions.objectType, query.objectType));
    if (query.status) conditions.push(eq(hrWorkflowDefinitions.status, query.status));

    const offset = (query.page - 1) * query.limit;

    const [rows, [{ total }]] = await Promise.all([
      this.db.select().from(hrWorkflowDefinitions)
        .where(and(...conditions))
        .orderBy(desc(hrWorkflowDefinitions.createdAt))
        .limit(query.limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrWorkflowDefinitions).where(and(...conditions)),
    ]);

    const withStepCounts = await Promise.all(rows.map(async (row) => {
      const steps = await this.db.select().from(hrWorkflowSteps)
        .where(eq(hrWorkflowSteps.definitionId, row.id));
      return { ...row, stepCount: steps.length };
    }));

    return { data: withStepCounts, total, page: query.page, limit: query.limit };
  }

  async get(orgId: string, id: number) {
    const [definition] = await this.db.select().from(hrWorkflowDefinitions)
      .where(and(eq(hrWorkflowDefinitions.id, id), eq(hrWorkflowDefinitions.orgId, orgId), isNull(hrWorkflowDefinitions.deletedAt)))
      .limit(1);

    if (!definition) throw new NotFoundException("Workflow definition not found");

    const steps = await this.db.select().from(hrWorkflowSteps)
      .where(eq(hrWorkflowSteps.definitionId, id))
      .orderBy(hrWorkflowSteps.stepOrder);

    return { ...definition, steps };
  }

  async create(orgId: string, dto: CreateWorkflowDefinitionDto) {
    try {
      const [definition] = await this.db.insert(hrWorkflowDefinitions).values({
        orgId,
        objectType: dto.objectType,
        name: dto.name,
        status: "draft",
        version: 1,
        isDefault: dto.isDefault,
        settings: dto.settings ?? {},
      }).returning();

      if (!definition) throw new Error("Insert failed");

      if (dto.isDefault) {
        await this.clearOtherDefaults(orgId, dto.objectType, definition.id);
      }

      await this.upsertSteps(definition.id, dto.steps);
      return this.get(orgId, definition.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("23505") || msg.includes("uniq_hr_wf_def")) {
        throw new ConflictException("A workflow with this name and version already exists for this object type");
      }
      throw err;
    }
  }

  async update(orgId: string, id: number, dto: UpdateWorkflowDefinitionDto) {
    const definition = await this.get(orgId, id);

    if (definition.status === "active") {
      throw new BadRequestException("Active definitions cannot be edited. Duplicate and edit the new version.");
    }

    const updates: Partial<typeof hrWorkflowDefinitions.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.isDefault !== undefined) updates.isDefault = dto.isDefault;
    if (dto.settings !== undefined) updates.settings = dto.settings;

    await this.db.update(hrWorkflowDefinitions)
      .set(updates)
      .where(and(eq(hrWorkflowDefinitions.id, id), eq(hrWorkflowDefinitions.orgId, orgId)));

    if (dto.isDefault) {
      await this.clearOtherDefaults(orgId, definition.objectType, id);
    }

    if (dto.steps) {
      await this.upsertSteps(id, dto.steps);
    }

    return this.get(orgId, id);
  }

  async activate(orgId: string, id: number) {
    const definition = await this.get(orgId, id);
    if (definition.status === "active") return definition;

    if (definition.steps.length === 0) {
      throw new BadRequestException("Cannot activate a workflow with no steps");
    }

    await this.db.update(hrWorkflowDefinitions)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(hrWorkflowDefinitions.id, id), eq(hrWorkflowDefinitions.orgId, orgId)));

    return this.get(orgId, id);
  }

  async archive(orgId: string, id: number) {
    await this.get(orgId, id);
    await this.db.update(hrWorkflowDefinitions)
      .set({ status: "archived", isDefault: false, updatedAt: new Date() })
      .where(and(eq(hrWorkflowDefinitions.id, id), eq(hrWorkflowDefinitions.orgId, orgId)));
    return this.get(orgId, id);
  }

  async duplicate(orgId: string, id: number) {
    const source = await this.get(orgId, id);

    const newName = `${source.name} (copy)`;
    const [newDef] = await this.db.insert(hrWorkflowDefinitions).values({
      orgId,
      objectType: source.objectType,
      name: newName,
      status: "draft",
      version: source.version + 1,
      isDefault: false,
      settings: source.settings ?? {},
    }).returning();

    if (!newDef) throw new Error("Duplicate failed");

    await this.upsertSteps(newDef.id, source.steps.map((s): StepInput => ({
      stepOrder: s.stepOrder,
      name: s.name,
      approverType: s.approverType as StepInput["approverType"],
      approverValue: s.approverValue ?? null,
      mode: s.mode as StepInput["mode"],
      slaHours: s.slaHours ?? null,
      escalationApproverType: s.escalationApproverType as StepInput["escalationApproverType"],
      escalationApproverValue: s.escalationApproverValue ?? null,
      condition: s.condition as StepInput["condition"] ?? null,
    })));

    return this.get(orgId, newDef.id);
  }

  async softDelete(orgId: string, id: number) {
    const definition = await this.get(orgId, id);
    if (definition.status === "active") {
      throw new BadRequestException("Archive the definition before deleting it");
    }
    await this.db.update(hrWorkflowDefinitions)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrWorkflowDefinitions.id, id), eq(hrWorkflowDefinitions.orgId, orgId)));
  }

  private async clearOtherDefaults(orgId: string, objectType: typeof hrWorkflowDefinitions.$inferSelect["objectType"], excludeId: number) {
    await this.db.update(hrWorkflowDefinitions)
      .set({ isDefault: false })
      .where(and(
        eq(hrWorkflowDefinitions.orgId, orgId),
        eq(hrWorkflowDefinitions.objectType, objectType),
        isNull(hrWorkflowDefinitions.deletedAt),
      ));
    await this.db.update(hrWorkflowDefinitions)
      .set({ isDefault: true })
      .where(and(eq(hrWorkflowDefinitions.id, excludeId), eq(hrWorkflowDefinitions.orgId, orgId)));
  }

  private async upsertSteps(definitionId: number, steps: StepInput[]) {
    await this.db.delete(hrWorkflowSteps).where(eq(hrWorkflowSteps.definitionId, definitionId));

    if (steps.length > 0) {
      await this.db.insert(hrWorkflowSteps).values(
        steps.map((s) => ({
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
