import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { hrAutomationRules, hrAutomationRuns } from "../../../db/schema/hr/automation-engine";
import type { HrAutomationAction, HrAutomationCondition, HrActionResult } from "../../../db/schema/hr/automation-engine";
import { logger } from "../../../common/logger/logger.service";
import { HrAutomationActionsService } from "./hr-automation-actions.service";
import type {
  CreateHrAutomationRuleInput,
  UpdateHrAutomationRuleInput,
  ListRunsInput,
} from "./dto/hr-automation.schemas";
import type { HrAutomationEvent } from "./hr-automation-events";
import type { HrWebhooksService } from "./hr-webhooks.service";
import { evaluateNormalizedCondition, evaluateNormalizedConditions, type NormalizedCondition } from "../../automation/shared-condition-evaluator";

const MAX_DEPTH = 3;
const COOLDOWN_MS = 5_000;

const recentRuleRuns = new Map<string, number>();

function cooldownKey(ruleId: number, entityId: string): string {
  return `${ruleId}:${entityId}`;
}

function toNormalized(c: HrAutomationCondition): NormalizedCondition {
  return { field: c.field, op: c.operator, value: c.value };
}

export interface EmitOptions {
  triggeredByRunId?: number;
  depth?: number;
}

@Injectable()
export class HrAutomationEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly actions: HrAutomationActionsService,
    @Optional() private readonly hrWebhooks: HrWebhooksService | null = null,
  ) {}

  async emit(
    orgId: string,
    event: HrAutomationEvent,
    payload: Record<string, unknown>,
    opts: EmitOptions = {},
  ): Promise<void> {
    const depth = opts.depth ?? 0;
    try {
      await this.runEvent(orgId, event, payload, opts.triggeredByRunId ?? null, depth);
    } catch (error) {
      logger.error("hr-automation emit failed", { orgId, event, error });
    }
    this.hrWebhooks?.dispatch(orgId, event, payload);
  }

  private async runEvent(
    orgId: string,
    event: HrAutomationEvent,
    payload: Record<string, unknown>,
    triggeredByRunId: number | null,
    depth: number,
  ): Promise<void> {
    const rules = await this.db.query.hrAutomationRules.findMany({
      where: and(
        eq(hrAutomationRules.orgId, orgId),
        eq(hrAutomationRules.triggerEvent, event),
        eq(hrAutomationRules.isEnabled, true),
        isNull(hrAutomationRules.deletedAt),
      ),
      columns: { id: true, conditions: true, actions: true, webhookSecret: true },
    });

    if (rules.length === 0) return;

    for (const rule of rules) {
      try {
        await this.processRule(orgId, rule, payload, event, triggeredByRunId, depth);
      } catch (error) {
        logger.error("hr-automation rule processing failed", { orgId, ruleId: rule.id, event, error });
      }
    }
  }

  private async processRule(
    orgId: string,
    rule: { id: number; conditions: HrAutomationCondition[]; actions: HrAutomationAction[]; webhookSecret: string | null },
    payload: Record<string, unknown>,
    event: HrAutomationEvent,
    triggeredByRunId: number | null,
    depth: number,
  ): Promise<void> {
    if (depth >= MAX_DEPTH) {
      await this.db.insert(hrAutomationRuns).values({
        orgId,
        ruleId: rule.id,
        triggerEvent: event,
        eventPayload: payload,
        status: "failed",
        error: "loop_prevented: max depth reached",
        triggeredByRunId,
        depth,
      });
      return;
    }

    const entityId = String(payload.employeeId ?? payload.cycleId ?? "");
    const ck = cooldownKey(rule.id, entityId);
    const lastRun = recentRuleRuns.get(ck);
    if (lastRun && Date.now() - lastRun < COOLDOWN_MS) {
      await this.db.insert(hrAutomationRuns).values({
        orgId,
        ruleId: rule.id,
        triggerEvent: event,
        eventPayload: payload,
        status: "skipped",
        error: "cooldown: same rule fired for same entity within 5s",
        triggeredByRunId,
        depth,
      });
      return;
    }

    const conditionsMet = evaluateNormalizedConditions(rule.conditions.map(toNormalized), payload);
    if (!conditionsMet) {
      await this.db.insert(hrAutomationRuns).values({
        orgId,
        ruleId: rule.id,
        triggerEvent: event,
        eventPayload: payload,
        status: "skipped",
        triggeredByRunId,
        depth,
      });
      return;
    }

    recentRuleRuns.set(ck, Date.now());

    const start = Date.now();
    const actionResults: HrActionResult[] = [];

    for (const action of rule.actions) {
      const result = await this.actions.execute(orgId, action, payload, rule.webhookSecret);
      actionResults.push(result);
    }

    const durationMs = Date.now() - start;
    const failures = actionResults.filter((r) => !r.ok);
    const status = failures.length === 0 ? "success" : failures.length < actionResults.length ? "partial" : "failed";

    await this.db.update(hrAutomationRules)
      .set({ runCount: sql`${hrAutomationRules.runCount} + 1`, lastRunAt: new Date() })
      .where(and(eq(hrAutomationRules.id, rule.id), eq(hrAutomationRules.orgId, orgId)));

    await this.db.insert(hrAutomationRuns).values({
      orgId,
      ruleId: rule.id,
      triggerEvent: event,
      eventPayload: payload,
      status,
      actionResults,
      error: failures.length > 0 ? failures.map((f) => `${f.type}: ${f.error}`).join("; ") : null,
      durationMs,
      triggeredByRunId,
      depth,
    });
  }

  async testRule(
    orgId: string,
    ruleId: number,
    payload: Record<string, unknown>,
  ): Promise<{
    matched: boolean;
    status: "success" | "partial" | "failed" | "skipped";
    matchedConditions: Array<{ condition: HrAutomationCondition; matched: boolean }>;
    wouldRunActions: HrAutomationAction[];
  }> {
    const rule = await this.db.query.hrAutomationRules.findFirst({
      where: and(eq(hrAutomationRules.id, ruleId), eq(hrAutomationRules.orgId, orgId), isNull(hrAutomationRules.deletedAt)),
      columns: { id: true, conditions: true, actions: true },
    });
    if (!rule) throw new NotFoundException("Automation rule not found");

    const matchedConditions = rule.conditions.map((c): { condition: HrAutomationCondition; matched: boolean } => ({
      condition: c,
      matched: evaluateNormalizedCondition(toNormalized(c), payload),
    }));

    const matched = matchedConditions.every((r) => r.matched);
    return {
      matched,
      status: matched ? "success" : "skipped",
      matchedConditions,
      wouldRunActions: matched ? rule.actions : [],
    };
  }

  async listRules(orgId: string, params: { search?: string; triggerEvent?: string; isEnabled?: boolean; page: number; limit: number }) {
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    const baseWhere = and(
      eq(hrAutomationRules.orgId, orgId),
      isNull(hrAutomationRules.deletedAt),
      params.triggerEvent ? eq(hrAutomationRules.triggerEvent, params.triggerEvent) : undefined,
      params.isEnabled !== undefined ? eq(hrAutomationRules.isEnabled, params.isEnabled) : undefined,
      params.search ? ilike(hrAutomationRules.name, `%${params.search}%`) : undefined,
    );

    return this.db.query.hrAutomationRules.findMany({
      where: baseWhere,
      orderBy: [desc(hrAutomationRules.createdAt)],
      limit,
      offset,
    });
  }

  async getRule(orgId: string, ruleId: number) {
    const rule = await this.db.query.hrAutomationRules.findFirst({
      where: and(eq(hrAutomationRules.id, ruleId), eq(hrAutomationRules.orgId, orgId), isNull(hrAutomationRules.deletedAt)),
    });
    if (!rule) throw new NotFoundException("Automation rule not found");
    return rule;
  }

  async createRule(orgId: string, userId: string, input: CreateHrAutomationRuleInput) {
    try {
      const [rule] = await this.db.insert(hrAutomationRules).values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        triggerEvent: input.triggerEvent,
        conditions: input.conditions as HrAutomationCondition[],
        actions: input.actions as HrAutomationAction[],
        isEnabled: input.isEnabled,
        webhookSecret: null,
        createdBy: userId,
      }).returning();
      return rule;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("23505")) {
        throw new ConflictException(`An automation rule named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async updateRule(orgId: string, ruleId: number, input: UpdateHrAutomationRuleInput) {
    try {
      const [updated] = await this.db.update(hrAutomationRules)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
          ...(input.conditions !== undefined ? { conditions: input.conditions as HrAutomationCondition[] } : {}),
          ...(input.actions !== undefined ? { actions: input.actions as HrAutomationAction[] } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(hrAutomationRules.id, ruleId), eq(hrAutomationRules.orgId, orgId), isNull(hrAutomationRules.deletedAt)))
        .returning();
      if (!updated) throw new NotFoundException("Automation rule not found");
      return updated;
    } catch (error: unknown) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      if (error instanceof Error && error.message.includes("23505")) {
        throw new ConflictException("An automation rule with that name already exists");
      }
      throw error;
    }
  }

  async toggleRule(orgId: string, ruleId: number, isEnabled: boolean) {
    const [updated] = await this.db.update(hrAutomationRules)
      .set({ isEnabled, updatedAt: new Date() })
      .where(and(eq(hrAutomationRules.id, ruleId), eq(hrAutomationRules.orgId, orgId), isNull(hrAutomationRules.deletedAt)))
      .returning();
    if (!updated) throw new NotFoundException("Automation rule not found");
    return updated;
  }

  async deleteRule(orgId: string, ruleId: number) {
    const [deleted] = await this.db.update(hrAutomationRules)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrAutomationRules.id, ruleId), eq(hrAutomationRules.orgId, orgId), isNull(hrAutomationRules.deletedAt)))
      .returning({ id: hrAutomationRules.id });
    if (!deleted) throw new NotFoundException("Automation rule not found");
    return { success: true };
  }

  async listRuns(orgId: string, params: { ruleId?: number } & ListRunsInput) {
    const { ruleId } = params;
    const limit = Math.min(params.limit, 100);
    const offset = (params.page - 1) * limit;
    const where = ruleId
      ? and(eq(hrAutomationRuns.orgId, orgId), eq(hrAutomationRuns.ruleId, ruleId))
      : eq(hrAutomationRuns.orgId, orgId);

    const [data, countRows] = await Promise.all([
      this.db.query.hrAutomationRuns.findMany({
        where,
        orderBy: [desc(hrAutomationRuns.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(hrAutomationRuns)
        .where(where),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      data,
      pagination: { page: params.page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
