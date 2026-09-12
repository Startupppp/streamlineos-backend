import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { crmBlueprints, crmBlueprintTransitions, crmPipelines, crmPipelineStages, auditLogs, dealActivities, leadActivities, quotes } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateBlueprintInput, UpdateBlueprintInput, CreateTransitionInput, UpdateTransitionInput } from "./dto/blueprints.schemas";

@Injectable()
export class CrmBlueprintsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db.select().from(crmBlueprints).where(eq(crmBlueprints.orgId, orgId)).limit(100);
  }

  async create(u: CurrentUserContext, input: CreateBlueprintInput) {
    await this.assertPipelineInOrg(u.orgId, input.pipelineId);
    const [row] = await this.db.insert(crmBlueprints).values({ orgId: u.orgId, ...input }).returning();
    void this.auditLog(u, "crm_blueprint.created", row.id, { name: input.name, pipelineId: input.pipelineId });
    return row;
  }

  async update(u: CurrentUserContext, blueprintId: string, input: UpdateBlueprintInput) {
    await this.assertOwner(u.orgId, blueprintId);
    const [row] = await this.db.update(crmBlueprints).set({ ...input, updatedAt: new Date() }).where(and(eq(crmBlueprints.id, blueprintId), eq(crmBlueprints.orgId, u.orgId))).returning();
    if (!row) throw new NotFoundException("Blueprint not found");
    void this.auditLog(u, "crm_blueprint.updated", blueprintId, Object.fromEntries(Object.entries(input)));
    return row;
  }

  async delete(u: CurrentUserContext, blueprintId: string) {
    await this.assertOwner(u.orgId, blueprintId);
    await this.db.update(crmBlueprints).set({ isActive: false, updatedAt: new Date() }).where(and(eq(crmBlueprints.id, blueprintId), eq(crmBlueprints.orgId, u.orgId)));
    void this.auditLog(u, "crm_blueprint.deleted", blueprintId, {});
    return { success: true };
  }

  async listTransitions(orgId: string, blueprintId: string) {
    return this.db.select().from(crmBlueprintTransitions).where(
      and(eq(crmBlueprintTransitions.orgId, orgId), eq(crmBlueprintTransitions.blueprintId, blueprintId)),
    ).limit(100);
  }

  async createTransition(u: CurrentUserContext, blueprintId: string, input: CreateTransitionInput) {
    await this.assertOwner(u.orgId, blueprintId);
    const [row] = await this.db.insert(crmBlueprintTransitions).values({ orgId: u.orgId, blueprintId, ...input }).returning();
    return row;
  }

  async updateTransition(u: CurrentUserContext, blueprintId: string, transitionId: string, input: UpdateTransitionInput) {
    await this.assertOwner(u.orgId, blueprintId);
    const [row] = await this.db.update(crmBlueprintTransitions)
      .set(input)
      .where(and(eq(crmBlueprintTransitions.id, transitionId), eq(crmBlueprintTransitions.blueprintId, blueprintId), eq(crmBlueprintTransitions.orgId, u.orgId)))
      .returning();
    if (!row) throw new NotFoundException("Transition not found");
    return row;
  }

  async deleteTransition(u: CurrentUserContext, blueprintId: string, transitionId: string) {
    await this.assertOwner(u.orgId, blueprintId);
    await this.db.delete(crmBlueprintTransitions).where(
      and(eq(crmBlueprintTransitions.id, transitionId), eq(crmBlueprintTransitions.blueprintId, blueprintId), eq(crmBlueprintTransitions.orgId, u.orgId)),
    );
    return { success: true };
  }

  async testTransition(orgId: string, blueprintId: string, fromStageKey: string, toStageKey: string, record: Record<string, unknown>) {
    const bp = await this.db.select({ pipelineId: crmBlueprints.pipelineId }).from(crmBlueprints).where(and(eq(crmBlueprints.id, blueprintId), eq(crmBlueprints.orgId, orgId))).limit(1).then((r) => r[0]);
    if (!bp) throw new NotFoundException("Blueprint not found");
    return this.assertTransitionAllowed(orgId, bp.pipelineId, fromStageKey, toStageKey, record, blueprintId);
  }

  async assertTransitionAllowed(
    orgId: string,
    pipelineId: string,
    fromStageKey: string,
    toStageKey: string,
    record: Record<string, unknown>,
    blueprintIdOverride?: string,
    entityType: "lead" | "deal" = "deal",
  ): Promise<{ allowed: boolean; requiresApproval: boolean; missingFields: string[] }> {
    const stage = await this.db.select({ allowedNextStageKeys: crmPipelineStages.allowedNextStageKeys }).from(crmPipelineStages).where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.pipelineId, pipelineId), eq(crmPipelineStages.key, fromStageKey), eq(crmPipelineStages.isActive, true))).limit(1).then((r) => r[0]);

    if (!stage) return { allowed: true, requiresApproval: false, missingFields: [] };

    const allowedKeys = stage.allowedNextStageKeys;
    if (allowedKeys !== null && !allowedKeys.includes(toStageKey)) {
      return { allowed: false, requiresApproval: false, missingFields: [] };
    }

    const blueprintCondition = blueprintIdOverride
      ? and(eq(crmBlueprints.id, blueprintIdOverride), eq(crmBlueprints.orgId, orgId))
      : and(eq(crmBlueprints.orgId, orgId), eq(crmBlueprints.pipelineId, pipelineId), eq(crmBlueprints.isActive, true));

    const blueprint = await this.db.select({ id: crmBlueprints.id }).from(crmBlueprints).where(blueprintCondition).limit(1).then((r) => r[0]);

    if (!blueprint) return { allowed: true, requiresApproval: false, missingFields: [] };

    const transition = await this.db.select().from(crmBlueprintTransitions).where(and(eq(crmBlueprintTransitions.blueprintId, blueprint.id), eq(crmBlueprintTransitions.orgId, orgId), eq(crmBlueprintTransitions.fromStageKey, fromStageKey), eq(crmBlueprintTransitions.toStageKey, toStageKey))).limit(1).then((r) => r[0]);

    if (!transition) return { allowed: true, requiresApproval: false, missingFields: [] };

    if (transition.requiresQuote) {
      const dealId = typeof record["id"] === "number" ? record["id"] : undefined;
      if (dealId !== undefined) {
        // "Has this deal any quote at all?" — the number was never used for
        // anything but the `=== 0` below, and an unbounded count() scans every
        // quote the deal has to answer it. One row is the whole answer.
        const anyQuote = await this.db
          .select({ one: sql`1` })
          .from(quotes)
          .where(and(eq(quotes.orgId, orgId), isNull(quotes.deletedAt), eq(quotes.dealId, dealId)))
          .limit(1);
        if (anyQuote.length === 0) {
          return {
            allowed: false,
            requiresApproval: Boolean(transition.requiresApproval),
            missingFields: ["__requires_quote__"],
          };
        }
      }
    }

    const requiredActivityKeys = transition.requiredActivityTypeKeys ?? [];
    if (requiredActivityKeys.length > 0) {
      const entityId = typeof record["id"] === "number" ? record["id"] : undefined;
      if (entityId !== undefined) {
        const activitiesTable = entityType === "lead" ? leadActivities : dealActivities;
        const idCol = entityType === "lead" ? leadActivities.leadId : dealActivities.dealId;
        const typeCol = entityType === "lead" ? leadActivities.type : dealActivities.type;
        const found = await this.db
          .select({ type: typeCol })
          .from(activitiesTable)
          .where(and(eq(idCol, entityId), inArray(typeCol, requiredActivityKeys)));
        const foundKeys = new Set(found.map((r) => r.type));
        const missingActivityKeys = requiredActivityKeys.filter((k) => !foundKeys.has(k));
        if (missingActivityKeys.length > 0) {
          return {
            allowed: false,
            requiresApproval: Boolean(transition.requiresApproval),
            missingFields: missingActivityKeys.map((k) => `__requires_activity_${k}__`),
          };
        }
      }
    }

    const requiredFields = transition.requiredFields ?? [];
    const missingFields = requiredFields.filter((f) => {
      const v = record[f];
      return v === null || v === undefined || v === "";
    });

    return {
      allowed: missingFields.length === 0,
      requiresApproval: Boolean(transition.requiresApproval),
      missingFields,
    };
  }

  private async assertPipelineInOrg(orgId: string, pipelineId: string) {
    const [pipeline] = await this.db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.orgId, orgId), isNull(crmPipelines.deletedAt)))
      .limit(1);
    if (!pipeline) throw new NotFoundException("Pipeline not found");
  }

  private async assertOwner(orgId: string, blueprintId: string) {
    const [b] = await this.db.select({ id: crmBlueprints.id }).from(crmBlueprints).where(and(eq(crmBlueprints.id, blueprintId), eq(crmBlueprints.orgId, orgId))).limit(1);
    if (!b) throw new NotFoundException("Blueprint not found");
    return b;
  }

  private auditLog(u: CurrentUserContext, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.db.insert(auditLogs).values({
      action,
      userId: u.userId,
      orgId: u.orgId,
      targetId,
      targetType: "crm_blueprint",
      metadata,
    }).then(() => undefined);
  }
}
