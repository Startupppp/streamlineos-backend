import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  crmAutomationRules,
  crmAutomationRuns,
  crmSequenceEnrollments,
  tasks,
} from "../../db/schema";
import type { CrmAutomationCondition } from "../../db/schema/crm/automation-rules";
import { logger } from "../../common/logger/logger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "../automation/automation-email.service";
import type { StudioEventPayload, RunStepLog } from "./types";
import { evaluateConditions } from "./crm-automation-condition-evaluator";
import type { CrmAutomationBusService } from "./crm-automation-bus.service";

const ALLOWLISTED_LEAD_FIELDS = ["status", "priority", "source", "assignedToId", "score"];
const ALLOWLISTED_DEAL_FIELDS = ["stage", "priority", "assignedToId"];

@Injectable()
export class CrmAutomationRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: AutomationEmailService,
    @Inject(forwardRef(() => "CrmAutomationBusService"))
    private readonly bus: CrmAutomationBusService,
  ) {}

  async executeRule(
    orgId: string,
    rule: typeof crmAutomationRules.$inferSelect,
    eventKey: string,
    payload: StudioEventPayload,
  ): Promise<void> {
    const steps: RunStepLog[] = [];
    let runId: string | undefined;

    try {
      const [run] = await this.db
        .insert(crmAutomationRuns)
        .values({ orgId, ruleId: rule.id, eventKey, entityType: payload.entityType, entityId: payload.entityId, status: "running", triggeredBy: payload.actorId ? "user" : "system" })
        .returning({ id: crmAutomationRuns.id });
      runId = run?.id;

      const legacyConditions = (rule.conditions ?? []) as CrmAutomationCondition[];
      const legacyActions = (rule.actions ?? []) as string[];

      const matched = evaluateConditions(
        legacyConditions.map((c) => ({ field: c.field, operator: "eq" as const, value: c.value })),
        payload.data,
      );

      if (!matched) {
        await this.finalizeRun(runId, "skipped", steps, null, rule.id, orgId, false);
        return;
      }

      for (const actionKey of legacyActions) {
        const stepLog = await this.executeAction(orgId, actionKey, {}, payload, steps);
        steps.push(stepLog);
      }

      const failed = steps.some((s) => s.status === "error");
      await this.finalizeRun(runId, failed ? "failed" : "success", steps, null, rule.id, orgId, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      logger.error("crm-automation-runner: rule execution failed", { orgId, ruleId: rule.id, error: err });
      if (runId) {
        await this.finalizeRun(runId, "failed", steps, msg, rule.id, orgId, false);
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

  private async executeAction(
    orgId: string,
    actionKey: string,
    config: Record<string, unknown>,
    payload: StudioEventPayload,
    _steps: RunStepLog[],
  ): Promise<RunStepLog> {
    const at = new Date().toISOString();
    const nodeId = `${actionKey}-${at}`;

    try {
      switch (actionKey) {
        case "create_task": {
          const dueDate = typeof config["dueInDays"] === "number"
            ? new Date(Date.now() + config["dueInDays"] * 86400000)
            : null;
          await this.db.insert(tasks).values({
            orgId,
            title: String(config["title"] ?? "Task from automation"),
            entityType: payload.entityType as "lead" | "deal" | "contact",
            entityId: parseInt(payload.entityId, 10),
            assigneeId: typeof config["assigneeId"] === "string" ? config["assigneeId"] : null,
            dueDate,
          });
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "send_notification": {
          if (typeof config["userId"] === "string") {
            await this.notifications.create({
              orgId,
              userId: config["userId"],
              title: String(config["title"] ?? "CRM Automation"),
              message: String(config["message"] ?? ""),
              category: "CRM",
            });
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "send_email": {
          await this.email.send({
            to: String(config["to"] ?? ""),
            subject: String(config["subject"] ?? ""),
            html: String(config["body"] ?? ""),
          });
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "call_webhook": {
          const url = String(config["url"] ?? "");
          if (url) {
            const body = JSON.stringify({ event: payload.entityType, entityId: payload.entityId, data: payload.data });
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: AbortSignal.timeout(10_000),
            });
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "start_sequence": {
          const seqId = String(config["sequenceId"] ?? "");
          if (seqId) {
            await this.db
              .insert(crmSequenceEnrollments)
              .values({ orgId, sequenceId: seqId, entityType: payload.entityType, entityId: payload.entityId })
              .onConflictDoNothing();
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "stop_sequence": {
          const seqId = String(config["sequenceId"] ?? "");
          if (seqId) {
            await this.db
              .update(crmSequenceEnrollments)
              .set({ status: "stopped", stopReason: "automation_action" })
              .where(and(
                eq(crmSequenceEnrollments.orgId, orgId),
                eq(crmSequenceEnrollments.sequenceId, seqId),
                eq(crmSequenceEnrollments.entityType, payload.entityType),
                eq(crmSequenceEnrollments.entityId, payload.entityId),
              ));
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "send_whatsapp":
        case "create_deal":
        case "create_quote":
          return { nodeId, type: actionKey, status: "skipped", message: "not_implemented", at };
        default:
          return { nodeId, type: actionKey, status: "skipped", message: "unknown_action", at };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      logger.error("crm-automation-runner: action failed", { orgId, actionKey, error: err });
      return { nodeId, type: actionKey, status: "error", message: msg, at };
    }
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
}
