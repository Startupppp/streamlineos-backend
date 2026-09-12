import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AutomationActionExecutor, type ActionResult } from "./automation-action-executor.service";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  supportTickets,
  type AutomationAction,
  type AutomationCondition,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { evaluateConditions, type EventPayload } from "./automation.evaluator";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "./dto/automation.schemas";
import {
  type AutomationTrigger,
  type EvaluationResult,
  type RuleDefinition,
  isValidTrigger,
} from "./automation-types";

export type { AutomationTrigger, EvaluationResult };

@Injectable()
export class AutomationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly actionExecutor: AutomationActionExecutor,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async runRule(orgId: string, rule: RuleDefinition, payload: EventPayload): Promise<EvaluationResult> {
    const matched = evaluateConditions(rule.conditions, payload);
    if (!matched) return { matched: false, actionResults: [] };

    const actionResults: ActionResult[] = [];
    for (const action of rule.actions) {
      actionResults.push(await this.actionExecutor.executeAction(orgId, action, payload));
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
    triggerPrefix?: string,
  ): Promise<{ runId: number; matched: boolean; status: "skipped" | "success" | "failed"; actionResults: ActionResult[] }> {
    const rule = await this.db.query.automationRules.findFirst({
      where: and(
        eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId),
        triggerPrefix ? like(automationRules.triggerEvent, `${triggerPrefix}%`) : undefined,
      ),
      columns: { id: true, triggerEvent: true, conditions: true, actions: true },
    });
    if (!rule) throw new NotFoundException("Automation not found");
    if (rule.actions.some((action) => action.type.startsWith("support_"))) {
      const ticketId = payload.ticketId;
      if (typeof ticketId !== "number" || !Number.isSafeInteger(ticketId) || ticketId <= 0)
        throw new NotFoundException("Ticket not found");
      const ticket = await this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.orgId, orgId), eq(supportTickets.id, ticketId)),
        columns: { id: true },
      });
      if (!ticket) throw new NotFoundException("Ticket not found");
    }

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
        conditions: input.conditions,
        actions: input.actions,
        isEnabled: input.isEnabled,
        createdBy: userId,
      })
      .returning();
    return rule;
  }

  async updateRule(orgId: string, ruleId: number, input: UpdateAutomationRuleInput, triggerPrefix?: string) {
    if (triggerPrefix && input.triggerEvent !== undefined && !input.triggerEvent.startsWith(triggerPrefix))
      throw new NotFoundException("Automation not found");
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
      .where(and(
        eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId),
        triggerPrefix ? like(automationRules.triggerEvent, `${triggerPrefix}%`) : undefined,
      ))
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteRule(orgId: string, ruleId: number, triggerPrefix?: string) {
    const [deleted] = await this.db
      .delete(automationRules)
      .where(and(
        eq(automationRules.id, ruleId), eq(automationRules.orgId, orgId),
        triggerPrefix ? like(automationRules.triggerEvent, `${triggerPrefix}%`) : undefined,
      ))
      .returning();
    if (!deleted) throw new NotFoundException("Automation not found");
    return { success: true };
  }

  listRuns(orgId: string, ruleId?: number, triggerPrefix?: string) {
    return this.db.query.automationRuns.findMany({
      where: and(
        eq(automationRuns.orgId, orgId),
        ruleId ? eq(automationRuns.ruleId, ruleId) : undefined,
        triggerPrefix ? like(automationRuns.triggerEvent, `${triggerPrefix}%`) : undefined,
      ),
      orderBy: (fields, { desc: descOp }) => [descOp(fields.createdAt)],
      limit: 100,
    });
  }
}
