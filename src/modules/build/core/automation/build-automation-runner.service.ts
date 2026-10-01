import { Inject, Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { projectAutomations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import {
  BuildAutomationRunHistoryService,
  type AutomationRunOutcome,
  type AutomationActionRunResult,
} from "./build-automation-run-history.service";
import {
  evaluateNormalizedCondition,
  type ConditionOp,
  type NormalizedCondition,
} from "../../../automation/shared-condition-evaluator";

type StoredCondition = NonNullable<typeof projectAutomations.$inferSelect>["conditions"][number];

export interface TicketEventPayload {
  ticketId: number;
  projectId: number;
  orgId: string;
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  title?: string;
  type?: string;
}

const BUILD_OP_MAP: Record<
  Exclude<StoredCondition["operator"], "is_empty" | "is_not_empty">,
  ConditionOp
> = {
  equals: "eq",
  not_equals: "neq",
  contains: "contains",
};

function evaluateBuildCondition(
  condition: StoredCondition,
  payload: Record<string, unknown>,
): boolean {
  if (condition.operator === "is_empty") {
    return !evaluateNormalizedCondition({ field: condition.field, op: "exists" }, payload);
  }
  if (condition.operator === "is_not_empty") {
    return evaluateNormalizedCondition({ field: condition.field, op: "exists" }, payload);
  }
  const normalized: NormalizedCondition = {
    field: condition.field,
    op: BUILD_OP_MAP[condition.operator],
    value: condition.value,
  };
  return evaluateNormalizedCondition(normalized, payload);
}

function evaluateBuildConditions(
  conditions: StoredCondition[],
  payload: Record<string, unknown>,
): boolean {
  if (conditions.length === 0) return true;
  return conditions.every((c) => evaluateBuildCondition(c, payload));
}

interface AutomationChainContext {
  readonly depth: number;
  readonly seen: ReadonlySet<string>;
}

const MAX_AUTOMATION_CHAIN_DEPTH = 3;
const automationChainStorage = new AsyncLocalStorage<AutomationChainContext>();

@Injectable()
export class BuildAutomationRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly rateLimiter: RateLimitService,
    private readonly history: BuildAutomationRunHistoryService,
    private readonly actionExecutor: BuildAutomationActionExecutor,
  ) {}

  private async execute(
    orgId: string,
    projectId: number,
    triggerEvent: string,
    ticket: TicketEventPayload,
  ): Promise<void> {
    const chainKey = `${ticket.ticketId}:${triggerEvent}`;
    const parent = automationChainStorage.getStore();

    if (parent && (parent.depth >= MAX_AUTOMATION_CHAIN_DEPTH || parent.seen.has(chainKey))) {
      logger.error("BuildAutomationRunner: loop guard blocked a re-entrant trigger", {
        orgId,
        projectId,
        triggerEvent,
        ticketId: ticket.ticketId,
        depth: parent.depth,
      });
      await this.history.recordRun({
        orgId,
        projectId,
        automationId: null,
        ticketId: ticket.ticketId,
        triggerEvent,
        matched: false,
        outcome: "blocked_loop_guard",
        errorMessage: `chain depth ${parent.depth} at or above ${MAX_AUTOMATION_CHAIN_DEPTH}, or "${chainKey}" already ran earlier in this chain`,
      });
      return;
    }

    const rateLimit = await this.rateLimiter.check("build:automation-run", `${orgId}:${projectId}`);
    if (!rateLimit.allowed) {
      logger.warn("BuildAutomationRunner: rate limit exceeded, skipping run", {
        orgId,
        projectId,
        triggerEvent,
        retryAfterSecs: rateLimit.retryAfterSecs,
      });
      await this.history.recordRun({
        orgId,
        projectId,
        automationId: null,
        ticketId: ticket.ticketId,
        triggerEvent,
        matched: false,
        outcome: "blocked_rate_limit",
        errorMessage: `retry after ${rateLimit.retryAfterSecs}s`,
      });
      return;
    }

    const nextContext: AutomationChainContext = parent
      ? { depth: parent.depth + 1, seen: new Set(parent.seen).add(chainKey) }
      : { depth: 1, seen: new Set([chainKey]) };

    await automationChainStorage.run(nextContext, () => this.runRules(orgId, projectId, triggerEvent, ticket));
  }

  private async runRules(
    orgId: string,
    projectId: number,
    triggerEvent: string,
    ticket: TicketEventPayload,
  ): Promise<void> {
    const rules = await this.db
      .select({
        id: projectAutomations.id,
        conditions: projectAutomations.conditions,
        actions: projectAutomations.actions,
        createdBy: projectAutomations.createdBy,
      })
      .from(projectAutomations)
      .where(
        and(
          eq(projectAutomations.orgId, orgId),
          eq(projectAutomations.projectId, projectId),
          eq(projectAutomations.triggerEvent, triggerEvent),
          eq(projectAutomations.isActive, true),
        ),
      );

    if (rules.length === 0) return;

    const payload: Record<string, unknown> = { ...ticket };

    for (const rule of rules) {
      let matched: boolean;
      try {
        matched = evaluateBuildConditions(rule.conditions, payload);
      } catch (error) {
        logger.error("BuildAutomationRunner: rule execution failed", { ruleId: rule.id, error });
        await this.history.recordRun({
          orgId,
          projectId,
          automationId: rule.id,
          ticketId: ticket.ticketId,
          triggerEvent,
          matched: false,
          outcome: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!matched) {
        await this.history.recordRun({
          orgId,
          projectId,
          automationId: rule.id,
          ticketId: ticket.ticketId,
          triggerEvent,
          matched: false,
          outcome: "not_matched",
          errorMessage: null,
        });
        continue;
      }

      const actionResults: AutomationActionRunResult[] = [];
      for (const [index, action] of rule.actions.entries()) {
        try {
          await this.actionExecutor.execute(orgId, ticket.projectId, ticket.ticketId, action, rule.createdBy);
          actionResults.push({ index, type: action.type, outcome: "success", errorMessage: null });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("BuildAutomationRunner: action failed", {
            ruleId: rule.id,
            actionType: action.type,
            error: errorMessage,
          });
          actionResults.push({ index, type: action.type, outcome: "failure", errorMessage });
        }
      }

      const failures = actionResults.filter((r) => r.outcome === "failure").length;
      const outcome: AutomationRunOutcome =
        failures === 0 ? "matched_success" : failures === actionResults.length ? "matched_failed" : "matched_partial_failure";

      const runId = await this.history.recordRun({
        orgId,
        projectId,
        automationId: rule.id,
        ticketId: ticket.ticketId,
        triggerEvent,
        matched: true,
        outcome,
        errorMessage: null,
      });

      if (runId !== null) await this.history.recordRunActions(orgId, runId, actionResults);
    }
  }

  runForTicketEvent(
    orgId: string,
    projectId: number,
    triggerEvent: string,
    ticket: TicketEventPayload,
  ): void {
    const chain = automationChainStorage.getStore();
    const start = (): Promise<void> =>
      chain
        ? automationChainStorage.run(chain, () => this.execute(orgId, projectId, triggerEvent, ticket))
        : this.execute(orgId, projectId, triggerEvent, ticket);
    const run = (): Promise<void> =>
      start().catch((error: unknown) => {
        logger.error("BuildAutomationRunner: unexpected failure", {
          orgId,
          projectId,
          triggerEvent,
          error,
        });
      });

    if (!registerAfterCommit(run)) void run();
  }
}
