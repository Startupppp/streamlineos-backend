import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationCondition,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { AutomationWebhookService } from "./automation-webhook.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { evaluateConditions, type EventPayload } from "./automation.evaluator";
import {
  executeAction,
  type ActionResult,
  type AutomationActionDeps,
} from "./lib/automation-actions";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "./dto/automation.schemas";

export type { ActionResult } from "./lib/automation-actions";

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

function isValidTrigger(value: string): value is AutomationTrigger {
  return (AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}

interface RuleDefinition {
  id: number;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

export interface EvaluationResult {
  matched: boolean;
  actionResults: ActionResult[];
}

@Injectable()
export class AutomationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: AutomationEmailService,
    private readonly webhookService: AutomationWebhookService,
    private readonly planLimits: PlanLimitsService,
    private readonly aiNodeExecutor: AiNodeExecutorService,
  ) {}

  private get actionDeps(): AutomationActionDeps {
    return {
      db: this.db,
      notifications: this.notifications,
      email: this.email,
      webhookService: this.webhookService,
      aiNodeExecutor: this.aiNodeExecutor,
    };
  }

  executeAction(
    orgId: string,
    action: AutomationAction,
    payload: EventPayload,
  ): Promise<ActionResult> {
    return executeAction(this.actionDeps, orgId, action, payload);
  }

  async runRule(orgId: string, rule: RuleDefinition, payload: EventPayload): Promise<EvaluationResult> {
    const matched = evaluateConditions(rule.conditions, payload);
    if (!matched) return { matched: false, actionResults: [] };

    const actionResults: ActionResult[] = [];
    for (const action of rule.actions) {
      actionResults.push(await this.executeAction(orgId, action, payload));
    }
    return { matched: true, actionResults };
  }

  /**
   * For callers that fire this and do not wait for it.
   *
   * `runAutomationsForEvent` reads `this.db`, which routes through the ambient
   * tenant transaction — correct for the callers that `await` it inside their
   * own, wrong for the ones that do not. A `void`-ed call from an outbox
   * consumer or a cron sweep runs after that transaction has committed, and
   * every query it makes is then issued against a closed handle: it does not
   * throw, it hangs, and the `try/catch` inside never sees anything to log. An
   * enabled automation rule simply never ran, and nothing anywhere said so.
   *
   * A detached run therefore gets a transaction of its own, and its failures
   * get somewhere to be seen.
   */
  runAutomationsForEventDetached(
    orgId: string,
    triggerEvent: AutomationTrigger,
    payload: EventPayload,
  ): void {
    void runInNewTenantTransaction(this.db, orgId, () =>
      this.runAutomationsForEvent(orgId, triggerEvent, payload),
    ).catch(logSideEffectFailure("automation dispatch", { orgId, triggerEvent }));
  }

  async runAutomationsForEvent(
    orgId: string,
    triggerEvent: AutomationTrigger,
    payload: EventPayload,
  ): Promise<void> {
    try {
      const rules = await this.db.query.automationRules.findMany({
        where: and(
          eq(automationRules.orgId, orgId),
          eq(automationRules.triggerEvent, triggerEvent),
          eq(automationRules.isEnabled, true),
        ),
        columns: { id: true, conditions: true, actions: true },
      });
      if (rules.length === 0) return;

      type RunInsert = typeof automationRuns.$inferInsert;
      const runRecords: RunInsert[] = [];
      const matchedRuleIds: number[] = [];

      for (const rule of rules) {
        try {
          const { matched, actionResults } = await this.runRule(orgId, rule, payload);
          const failures = actionResults.filter((result) => !result.ok);

          if (matched) matchedRuleIds.push(rule.id);

          runRecords.push(
            matched
              ? {
                  orgId,
                  ruleId: rule.id,
                  triggerEvent,
                  status: failures.length === 0 ? "success" : "failed",
                  payload,
                  result: { actionResults },
                  error:
                    failures.length > 0
                      ? failures.map((failure) => `${failure.type}: ${failure.error}`).join("; ")
                      : null,
                }
              : {
                  orgId,
                  ruleId: rule.id,
                  triggerEvent,
                  status: "skipped",
                  payload,
                },
          );
        } catch (error) {
          logger.error("automation rule execution failed", { orgId, ruleId: rule.id, triggerEvent, cause: error });
        }
      }

      if (runRecords.length > 0) {
        await this.db.insert(automationRuns).values(runRecords);
      }

      if (matchedRuleIds.length > 0) {
        const now = new Date();
        await this.db
          .update(automationRules)
          .set({ runCount: sql`${automationRules.runCount} + 1`, lastRunAt: now })
          .where(and(eq(automationRules.orgId, orgId), inArray(automationRules.id, matchedRuleIds)));
      }
    } catch (error) {
      logger.error("runAutomationsForEvent failed", { orgId, triggerEvent, cause: error });
    }
  }

  async testRule(
    orgId: string,
    ruleId: number,
    payload: EventPayload,
  ): Promise<{ runId: number; matched: boolean; status: "skipped" | "success" | "failed"; actionResults: ActionResult[] }> {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)),
      columns: { id: true, triggerEvent: true, conditions: true, actions: true },
    });
    if (!rule) throw new NotFoundException("Automation not found");

    const { matched, actionResults } = await this.runRule(
      orgId,
      { id: rule.id, conditions: rule.conditions, actions: rule.actions },
      payload,
    );

    const failures = actionResults.filter((result) => !result.ok);
    const status = !matched ? "skipped" : failures.length === 0 ? "success" : "failed";

    const [run] = await this.db
      .insert(automationRuns)
      .values({
        orgId,
        ruleId: rule.id,
        triggerEvent: rule.triggerEvent,
        status,
        payload,
        result: { matched, actionResults, test: true },
        error:
          failures.length > 0
            ? failures.map((failure) => `${failure.type}: ${failure.error}`).join("; ")
            : null,
      })
      .returning({ id: automationRuns.id });

    return { runId: run.id, matched, status, actionResults };
  }

  async listRules(
    orgId: string,
    triggerPrefixOrParams?: string | { page?: number; limit?: number; triggerPrefix?: string },
  ) {
    const triggerPrefix =
      typeof triggerPrefixOrParams === "string"
        ? triggerPrefixOrParams
        : triggerPrefixOrParams?.triggerPrefix;
    const pageNum = typeof triggerPrefixOrParams === "object" ? (triggerPrefixOrParams.page ?? 1) : 1;
    const limit = Math.min(
      typeof triggerPrefixOrParams === "object" ? (triggerPrefixOrParams.limit ?? 20) : 100,
      100,
    );
    const offset = (pageNum - 1) * limit;
    const where = triggerPrefix
      ? and(eq(automationRules.orgId, orgId), like(automationRules.triggerEvent, `${triggerPrefix}%`))
      : eq(automationRules.orgId, orgId);

    const [data, countRows] = await Promise.all([
      this.db.query.automationRules.findMany({
        where,
        orderBy: (fields, { desc: descOp }) => [descOp(fields.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(automationRules)
        .where(where),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      data,
      pagination: { page: pageNum, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createRule(orgId: string, userId: string, input: CreateAutomationRuleInput) {
    if (!isValidTrigger(input.triggerEvent)) {
      throw new NotFoundException(`Unknown trigger event: ${input.triggerEvent}`);
    }
    await this.planLimits.assertWithinLimit(orgId, "automations");
    const [rule] = await this.db
      .insert(automationRules)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        triggerEvent: input.triggerEvent,
        conditions: input.conditions as AutomationCondition[],
        actions: input.actions as AutomationAction[],
        isEnabled: input.isEnabled,
        createdBy: userId,
      })
      .returning();
    return rule;
  }

  async updateRule(orgId: string, ruleId: number, input: UpdateAutomationRuleInput) {
    const [updated] = await this.db
      .update(automationRules)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions as AutomationCondition[] } : {}),
        ...(input.actions !== undefined ? { actions: input.actions as AutomationAction[] } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteRule(orgId: string, ruleId: number) {
    const [deleted] = await this.db
      .delete(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Automation not found");
    return { success: true };
  }

  listRuns(orgId: string, ruleId?: number) {
    return this.db.query.automationRuns.findMany({
      where: ruleId
        ? and(eq(automationRuns.orgId, orgId), eq(automationRuns.ruleId, ruleId))
        : eq(automationRuns.orgId, orgId),
      orderBy: (fields, { desc: descOp }) => [descOp(fields.createdAt)],
      limit: 100,
    });
  }
}
