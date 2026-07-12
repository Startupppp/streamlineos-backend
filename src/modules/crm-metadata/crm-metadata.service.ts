import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, asc } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  crmPipelines, crmPipelineStages, crmOptions, crmUiMetadata, auditLogs,
} from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  CreatePipelineInput, UpdatePipelineInput, CreateStageInput,
  UpdateStageInput, ReorderStagesInput, CreateOptionInput, UpdateOptionInput,
} from "./dto/metadata.schemas";

const metaKey = (orgId: string) => `crm:metadata:${orgId}`;

@Injectable()
export class CrmMetadataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getAggregate(orgId: string) {
    return this.cache.cached(
      metaKey(orgId),
      () => this.fetchAggregate(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchAggregate(orgId: string) {
    const [pipelines, stages, options, ui] = await Promise.all([
      this.db.select().from(crmPipelines).where(and(eq(crmPipelines.orgId, orgId), eq(crmPipelines.isActive, true))).orderBy(asc(crmPipelines.sortOrder)),
      this.db.select().from(crmPipelineStages).where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isActive, true))).orderBy(asc(crmPipelineStages.sortOrder)),
      this.db.select().from(crmOptions).where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.isActive, true))).orderBy(asc(crmOptions.sortOrder)),
      this.db.select().from(crmUiMetadata).where(eq(crmUiMetadata.orgId, orgId)),
    ]);
    return { pipelines, stages, options, uiMetadata: ui };
  }

  async listPipelines(orgId: string) {
    return this.db.select().from(crmPipelines).where(eq(crmPipelines.orgId, orgId)).orderBy(asc(crmPipelines.sortOrder));
  }

  async createPipeline(u: CurrentUserContext, input: CreatePipelineInput) {
    const existing = await this.db.select({ id: crmPipelines.id }).from(crmPipelines).where(and(eq(crmPipelines.orgId, u.orgId), eq(crmPipelines.key, input.key))).limit(1);
    if (existing.length > 0) throw new ConflictException(`Pipeline key "${input.key}" already exists`);
    const [row] = await this.db.insert(crmPipelines).values({ orgId: u.orgId, ...input }).returning();
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_pipeline.created", row!.id, { key: input.key, name: input.name });
    return row;
  }

  async updatePipeline(u: CurrentUserContext, pipelineId: string, input: UpdatePipelineInput) {
    await this.assertPipelineOwner(u.orgId, pipelineId);
    const [row] = await this.db.update(crmPipelines).set({ ...input, updatedAt: new Date() }).where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.orgId, u.orgId))).returning();
    if (!row) throw new NotFoundException("Pipeline not found");
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_pipeline.updated", pipelineId, input as Record<string, unknown>);
    return row;
  }

  async deletePipeline(u: CurrentUserContext, pipelineId: string) {
    await this.assertPipelineOwner(u.orgId, pipelineId);
    await this.db.update(crmPipelines).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() }).where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.orgId, u.orgId)));
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_pipeline.deleted", pipelineId, {});
    return { success: true };
  }

  async listStages(orgId: string, pipelineId: string) {
    await this.assertPipelineOwner(orgId, pipelineId);
    return this.db.select().from(crmPipelineStages).where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.pipelineId, pipelineId))).orderBy(asc(crmPipelineStages.sortOrder));
  }

  async createStage(u: CurrentUserContext, pipelineId: string, input: CreateStageInput) {
    await this.assertPipelineOwner(u.orgId, pipelineId);
    const existing = await this.db.select({ id: crmPipelineStages.id }).from(crmPipelineStages).where(and(eq(crmPipelineStages.orgId, u.orgId), eq(crmPipelineStages.pipelineId, pipelineId), eq(crmPipelineStages.key, input.key))).limit(1);
    if (existing.length > 0) throw new ConflictException(`Stage key "${input.key}" already exists in this pipeline`);
    const [row] = await this.db.insert(crmPipelineStages).values({
      orgId: u.orgId,
      pipelineId,
      ...input,
      requiredFields: input.requiredFields ?? [],
      allowedNextStageKeys: input.allowedNextStageKeys ?? null,
    }).returning();
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_stage.created", row!.id, { pipelineId, key: input.key });
    return row;
  }

  async updateStage(u: CurrentUserContext, stageId: string, input: UpdateStageInput) {
    await this.assertStageOwner(u.orgId, stageId);
    const [row] = await this.db.update(crmPipelineStages).set({ ...input, updatedAt: new Date() }).where(and(eq(crmPipelineStages.id, stageId), eq(crmPipelineStages.orgId, u.orgId))).returning();
    if (!row) throw new NotFoundException("Stage not found");
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_stage.updated", stageId, input as Record<string, unknown>);
    return row;
  }

  async deleteStage(u: CurrentUserContext, stageId: string) {
    const stage = await this.assertStageOwner(u.orgId, stageId);
    await this.db.update(crmPipelineStages).set({ isActive: false, updatedAt: new Date() }).where(and(eq(crmPipelineStages.id, stageId), eq(crmPipelineStages.orgId, u.orgId)));
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_stage.deleted", stageId, { key: stage.key });
    return { success: true };
  }

  async reorderStages(u: CurrentUserContext, pipelineId: string, input: ReorderStagesInput) {
    await this.assertPipelineOwner(u.orgId, pipelineId);
    await Promise.all(
      input.stageIds.map((id, index) =>
        this.db.update(crmPipelineStages).set({ sortOrder: index, updatedAt: new Date() }).where(and(eq(crmPipelineStages.id, id), eq(crmPipelineStages.orgId, u.orgId), eq(crmPipelineStages.pipelineId, pipelineId))),
      ),
    );
    await this.invalidateMeta(u.orgId);
    return { success: true };
  }

  async listOptions(orgId: string, optionType: string) {
    return this.db.select().from(crmOptions).where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, optionType))).orderBy(asc(crmOptions.sortOrder));
  }

  async createOption(u: CurrentUserContext, optionType: string, input: CreateOptionInput) {
    const existing = await this.db.select({ id: crmOptions.id }).from(crmOptions).where(and(eq(crmOptions.orgId, u.orgId), eq(crmOptions.type, optionType), eq(crmOptions.key, input.key))).limit(1);
    if (existing.length > 0) throw new ConflictException(`Option key "${input.key}" already exists for type "${optionType}"`);
    const [row] = await this.db.insert(crmOptions).values({ orgId: u.orgId, type: optionType, ...input }).returning();
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_option.created", row!.id, { type: optionType, key: input.key });
    return row;
  }

  async updateOption(u: CurrentUserContext, optionType: string, optionId: string, input: UpdateOptionInput) {
    const opt = await this.db.select({ id: crmOptions.id, type: crmOptions.type }).from(crmOptions).where(and(eq(crmOptions.id, optionId), eq(crmOptions.orgId, u.orgId))).limit(1).then((r) => r[0]);
    if (!opt || opt.type !== optionType) throw new NotFoundException("Option not found");
    const [row] = await this.db.update(crmOptions).set({ ...input, updatedAt: new Date() }).where(and(eq(crmOptions.id, optionId), eq(crmOptions.orgId, u.orgId))).returning();
    if (!row) throw new NotFoundException("Option not found");
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_option.updated", optionId, input as Record<string, unknown>);
    return row;
  }

  async deleteOption(u: CurrentUserContext, optionType: string, optionId: string) {
    const opt = await this.db.select({ id: crmOptions.id, type: crmOptions.type, key: crmOptions.key }).from(crmOptions).where(and(eq(crmOptions.id, optionId), eq(crmOptions.orgId, u.orgId))).limit(1).then((r) => r[0]);
    if (!opt || opt.type !== optionType) throw new NotFoundException("Option not found");
    await this.db.update(crmOptions).set({ isActive: false, updatedAt: new Date() }).where(and(eq(crmOptions.id, optionId), eq(crmOptions.orgId, u.orgId)));
    await this.invalidateMeta(u.orgId);
    void this.auditLog(u, "crm_option.deleted", optionId, { type: optionType, key: opt.key });
    return { success: true };
  }

  private async assertPipelineOwner(orgId: string, pipelineId: string) {
    const [p] = await this.db.select({ id: crmPipelines.id }).from(crmPipelines).where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.orgId, orgId))).limit(1);
    if (!p) throw new NotFoundException("Pipeline not found");
    return p;
  }

  private async assertStageOwner(orgId: string, stageId: string) {
    const [s] = await this.db.select({ id: crmPipelineStages.id, key: crmPipelineStages.key }).from(crmPipelineStages).where(and(eq(crmPipelineStages.id, stageId), eq(crmPipelineStages.orgId, orgId))).limit(1);
    if (!s) throw new NotFoundException("Stage not found");
    return s;
  }

  private async invalidateMeta(orgId: string) {
    await this.cache.invalidate(metaKey(orgId));
  }

  private auditLog(u: CurrentUserContext, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.db.insert(auditLogs).values({
      action,
      userId: u.userId,
      orgId: u.orgId,
      targetId,
      targetType: "crm_metadata",
      metadata,
    }).then(() => undefined);
  }
}
