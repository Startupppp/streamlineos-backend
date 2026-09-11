import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { automationRules, automationRuns } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type {
  CreateAutomationInput,
  ListAutomationsQueryInput,
  UpdateAutomationInput,
} from "./dto/settings.schemas";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";

@Injectable()
export class SettingsAutomationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async listAutomations(orgId: string, params: ListAutomationsQueryInput) {
    const limit = Math.min(params.limit, 100);
    const position = decodeCursor(params.cursor);
    const where = and(
      eq(automationRules.orgId, orgId),
      position ? keysetBeforeId(automationRules.createdAt, automationRules.id, position) : undefined,
    );

    const data = await this.db
        .select({
          id: automationRules.id,
          name: automationRules.name,
          description: automationRules.description,
          triggerEvent: automationRules.triggerEvent,
          conditions: automationRules.conditions,
          actions: automationRules.actions,
          isEnabled: automationRules.isEnabled,
          runCount: automationRules.runCount,
          lastRunAt: automationRules.lastRunAt,
          createdAt: automationRules.createdAt,
          updatedAt: automationRules.updatedAt,
        })
        .from(automationRules)
        .where(where)
        .orderBy(desc(automationRules.createdAt), desc(automationRules.id))
        .limit(limit + 1);

    return buildCursorPage(data, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createAutomation(orgId: string, userId: string, input: CreateAutomationInput) {
    await this.planLimits.assertWithinLimit(orgId, "automations");
    const [rule] = await this.db
      .insert(automationRules)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        triggerEvent: input.triggerEvent,
        conditions: input.conditions,
        actions: input.actions,
        isEnabled: input.isEnabled,
        createdBy: userId,
      })
      .returning();

    return rule;
  }

  async getAutomation(orgId: string, ruleId: number) {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)),
    });
    if (!rule) throw new NotFoundException("Automation not found");
    return rule;
  }

  async updateAutomation(orgId: string, ruleId: number, input: UpdateAutomationInput) {
    const [updated] = await this.db
      .update(automationRules)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
        ...(input.actions !== undefined ? { actions: input.actions } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(orgId: string, ruleId: number) {
    const [deleted] = await this.db
      .delete(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning({ id: automationRules.id });

    if (!deleted) throw new NotFoundException("Automation not found");
    return { success: true };
  }

  async listAutomationRuns(orgId: string, ruleId: number) {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)),
      columns: { id: true },
    });
    if (!rule) throw new NotFoundException("Automation not found");

    return this.db
      .select({
        id: automationRuns.id,
        triggerEvent: automationRuns.triggerEvent,
        status: automationRuns.status,
        payload: automationRuns.payload,
        result: automationRuns.result,
        error: automationRuns.error,
        createdAt: automationRuns.createdAt,
      })
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, ruleId), eq(automationRuns.orgId, orgId)))
      .orderBy(desc(automationRuns.createdAt))
      .limit(50);
  }
}
