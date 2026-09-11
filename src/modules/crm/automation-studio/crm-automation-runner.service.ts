import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmAutomationRules, crmAutomationRuns } from "../../../db/schema";
import type { CrmAutomationCondition, AutomationGraphNode } from "../../../db/schema/crm/automation-rules";
import { logger } from "../../../common/logger/logger.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { CrmOutboundEmailService } from "../consent/crm-outbound-email.service";
import type { StudioEventPayload, RunStepLog } from "./types";
import { evaluateConditions, type StudioCondition } from "./crm-automation-condition-evaluator";
import {
  executeAction,
  type AutomationActionDeps,
} from "./lib/automation-actions";

const STUDIO_OPERATORS: readonly StudioCondition["operator"][] = [
  "eq", "neq", "gt", "lt", "contains", "in", "changed_to",
];

function isStudioOperator(value: unknown): value is StudioCondition["operator"] {
  return typeof value === "string" && STUDIO_OPERATORS.some((operator) => operator === value);
}

@Injectable()
export class CrmAutomationRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: CrmOutboundEmailService,
  ) {}

  async executeRule(
    orgId: string,
    rule: typeof crmAutomationRules.$inferSelect,
    eventKey: string,
    payload: StudioEventPayload,
  ): Promise<void> {
    let runSteps: RunStepLog[] = [];
    let runId: string | undefined;

    try {
      const [run] = await this.db
        .insert(crmAutomationRuns)
        .values({ orgId, ruleId: rule.id, eventKey, entityType: payload.entityType, entityId: payload.entityId, status: "running", triggeredBy: payload.actorId ? "user" : "system" })
        .returning({ id: crmAutomationRuns.id });
      runId = run?.id;

      const graph = rule.graph ?? [];

      if (graph.length > 0) {
        runSteps = await this.walkGraph(orgId, graph, payload);
      } else {
        const legacyConditions = rule.conditions;
        const legacyActions = rule.actions;

        const matched = evaluateConditions(
          legacyConditions.map((c) => ({ field: c.field, operator: "eq" as const, value: c.value })),
          payload.data,
        );

        if (!matched) {
          await this.finalizeRun(runId, "skipped", [], null, rule.id, orgId, false);
          return;
        }

        for (const actionKey of legacyActions) {
          const stepLog = await this.executeAction(orgId, actionKey, {}, payload);
          runSteps.push(stepLog);
        }
      }

      const failed = runSteps.some((s) => s.status === "error");
      await this.finalizeRun(runId, failed ? "failed" : "success", runSteps, null, rule.id, orgId, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      logger.error("crm-automation-runner: rule execution failed", { orgId, ruleId: rule.id, error: err });
      if (runId) {
        await this.finalizeRun(runId, "failed", runSteps, msg, rule.id, orgId, false);
      }
      await this.db
        .update(crmAutomationRules)
        .set({ lastError: msg })
        .where(and(eq(crmAutomationRules.id, rule.id), eq(crmAutomationRules.orgId, orgId)));
    }
  }

  private async finalizeRun(
    runId: string | undefined,
    status: string,
    steps: RunStepLog[],
    error: string | null,
    ruleId: number,
    orgId: string,
    incrementCount: boolean,
  ): Promise<void> {
    if (runId) {
      await this.db
        .update(crmAutomationRuns)
        .set({ status, steps, error, finishedAt: new Date() })
        .where(eq(crmAutomationRuns.id, runId));
    }
    if (incrementCount) {
      await this.db
        .update(crmAutomationRules)
        .set({ executionCount: sql`${crmAutomationRules.executionCount} + 1`, lastRunAt: new Date() })
        .where(and(eq(crmAutomationRules.id, ruleId), eq(crmAutomationRules.orgId, orgId)));
    }
  }

  private async walkGraph(
    orgId: string,
    nodes: AutomationGraphNode[],
    payload: StudioEventPayload,
  ): Promise<RunStepLog[]> {
    const MAX_NODES = 50;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const steps: RunStepLog[] = [];
    const visited = new Set<string>();

    const startNode = nodes[0];
    if (!startNode) return steps;
    let current: AutomationGraphNode | undefined = startNode;

    while (current) {
      if (visited.size >= MAX_NODES) {
        steps.push({ nodeId: current.id, type: current.type, status: "error", message: "max_nodes_exceeded", at: new Date().toISOString() });
        break;
      }
      if (visited.has(current.id)) {
        steps.push({ nodeId: current.id, type: current.type, status: "error", message: "cycle_detected", at: new Date().toISOString() });
        break;
      }
      visited.add(current.id);

      if (current.type === "exit") {
        steps.push({ nodeId: current.id, type: "exit", status: "ok", at: new Date().toISOString() });
        break;
      }

      if (current.type === "condition") {
        const branches = current.branches ?? [];
        let branchTaken: string | undefined;
        let nextId: string | undefined;

        for (const branch of branches) {
          const cond = branch.condition;
          const studioCond: StudioCondition = {
            field: typeof cond.field === "string" ? cond.field : "",
            operator: isStudioOperator(cond.operator) ? cond.operator : "eq",
            value: typeof cond.value === "string" ? cond.value : String(cond.value ?? ""),
          };
          if (evaluateConditions([studioCond], payload.data)) {
            nextId = branch.nextId;
            branchTaken = branch.nextId;
            break;
          }
        }

        if (!nextId) nextId = current.nextId;

        steps.push({ nodeId: current.id, type: "condition", status: "ok", branchTaken, at: new Date().toISOString() });
        current = nextId ? nodeMap.get(nextId) : undefined;
        continue;
      }

      if (current.type === "wait") {
        steps.push({ nodeId: current.id, type: "wait", status: "skipped", message: "wait_not_scheduled", at: new Date().toISOString() });
        current = current.nextId ? nodeMap.get(current.nextId) : undefined;
        continue;
      }

      const stepLog = await this.executeAction(orgId, current.type, current.config ?? {}, payload);
      steps.push({ ...stepLog, nodeId: current.id });
      current = current.nextId ? nodeMap.get(current.nextId) : undefined;
    }

    return steps;
  }

  private executeAction(
    orgId: string,
    actionKey: string,
    config: Record<string, unknown>,
    payload: StudioEventPayload,
  ): Promise<RunStepLog> {
    return executeAction(this.actionDeps, orgId, actionKey, config, payload);
  }

  async dryRunConditions(
    conditions: CrmAutomationCondition[],
    samplePayload: Record<string, unknown>,
  ): Promise<{ matched: boolean; nodes: Array<{ nodeId: string; type: string; result: string }> }> {
    const nodes = conditions.map((c, i) => {
      const cond = { field: c.field, operator: "eq" as const, value: c.value };
      const pass = evaluateConditions([cond], samplePayload);
      return { nodeId: `condition-${i}`, type: "condition", result: pass ? "pass" : "skip" };
    });
    const matched = nodes.length === 0 || nodes.every((n) => n.result === "pass");
    return { matched, nodes };
  }

  private get actionDeps(): AutomationActionDeps {
    return { db: this.db, notifications: this.notifications, email: this.email };
  }
}