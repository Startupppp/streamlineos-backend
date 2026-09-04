import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  crmAutomationRules,
  crmAutomationRuns,
  crmSequenceEnrollments,
  tasks,
  deals,
  organizationMembers,
} from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD } from "../crm-party-reads";
import type { CrmAutomationCondition, AutomationGraphNode } from "../../../db/schema/crm/automation-rules";
import { logger } from "../../../common/logger/logger.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { CrmOutboundEmailService } from "../consent/crm-outbound-email.service";
import type { StudioEventPayload, RunStepLog } from "./types";
import { evaluateConditions, type StudioCondition } from "./crm-automation-condition-evaluator";
import { updateMirroredLeads } from "../../party/party-legacy-leads";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import { outboundTraceHeaders } from "../../../common/outbound/call-provider";

const ALLOWLISTED_LEAD_FIELDS = ["status", "priority", "source", "assignedToId", "score"];
const ALLOWLISTED_DEAL_FIELDS = ["stage", "priority", "assignedToId"];

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

      const graph = (rule.graph ?? []) as AutomationGraphNode[];

      if (graph.length > 0) {
        runSteps = await this.walkGraph(orgId, graph, payload);
      } else {
        const legacyConditions = (rule.conditions ?? []) as CrmAutomationCondition[];
        const legacyActions = (rule.actions ?? []) as string[];

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
          const cond = branch.condition as { field?: unknown; operator?: unknown; value?: unknown };
          const studioCond: StudioCondition = {
            field: typeof cond.field === "string" ? cond.field : "",
            operator: (typeof cond.operator === "string" ? cond.operator : "eq") as StudioCondition["operator"],
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

  private async executeAction(
    orgId: string,
    actionKey: string,
    config: Record<string, unknown>,
    payload: StudioEventPayload,
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
            entityType: payload.entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
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
          await this.email.send(orgId, {
            to: String(config["to"] ?? ""),
            subject: String(config["subject"] ?? ""),
            html: String(config["body"] ?? ""),
          });
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "call_webhook": {
          const url = String(config["url"] ?? "");
          if (url) {
            const urlCheck = await checkWebhookUrl(url);
            if (!urlCheck.allowed) throw new Error(`SSRF: webhook URL blocked (${urlCheck.reason})`);
            const body = JSON.stringify({ event: payload.entityType, entityId: payload.entityId, data: payload.data });
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...outboundTraceHeaders() },
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
        case "assign_owner": {
          const targetUserId = typeof config["userId"] === "string" ? config["userId"] : null;
          if (!targetUserId) return { nodeId, type: actionKey, status: "skipped", message: "missing_userId", at };
          const [membership] = await this.db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)))
            .limit(1);
          if (!membership) return { nodeId, type: actionKey, status: "error", message: "user_not_in_org", at };
          if (payload.entityType === "lead") {
            await updateMirroredLeads(this.db, orgId, [parseInt(payload.entityId, 10)], {
              assignedToId: targetUserId,
            });
          } else if (payload.entityType === "deal") {
            await this.db.update(deals).set({ assignedToId: targetUserId })
              .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.id, parseInt(payload.entityId, 10))));
          } else {
            return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "update_field": {
          const field = typeof config["field"] === "string" ? config["field"] : null;
          const value = config["value"] ?? null;
          if (!field) return { nodeId, type: actionKey, status: "skipped", message: "missing_field", at };
          if (payload.entityType === "lead") {
            if (!ALLOWLISTED_LEAD_FIELDS.includes(field)) {
              return { nodeId, type: actionKey, status: "error", message: "field_not_allowed", at };
            }
            // Every allowlisted field is a mirrored `leads` column, so the writer
            // translates the dynamic key into its party column rather than this
            // switch needing a second copy of the mapping.
            await updateMirroredLeads(this.db, orgId, [parseInt(payload.entityId, 10)], {
              [field]: value,
            });
          } else if (payload.entityType === "deal") {
            if (!ALLOWLISTED_DEAL_FIELDS.includes(field)) {
              return { nodeId, type: actionKey, status: "error", message: "field_not_allowed", at };
            }
            await this.db.update(deals).set({ [field]: value })
              .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.id, parseInt(payload.entityId, 10))));
          } else {
            return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
          }
          return { nodeId, type: actionKey, status: "ok", at };
        }
        case "add_tag": {
          const tag = typeof config["tag"] === "string" ? config["tag"].trim() : null;
          if (!tag) return { nodeId, type: actionKey, status: "skipped", message: "missing_tag", at };
          if (payload.entityType === "lead") {
            await this.changeLeadTags(orgId, parseInt(payload.entityId, 10), (tags) =>
              tags.includes(tag) ? tags : [...tags, tag],
            );
            return { nodeId, type: actionKey, status: "ok", at };
          }
          return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
        }
        case "remove_tag": {
          const tag = typeof config["tag"] === "string" ? config["tag"].trim() : null;
          if (!tag) return { nodeId, type: actionKey, status: "skipped", message: "missing_tag", at };
          if (payload.entityType === "lead") {
            await this.changeLeadTags(orgId, parseInt(payload.entityId, 10), (tags) =>
              tags.filter((existing) => existing !== tag),
            );
            return { nodeId, type: actionKey, status: "ok", at };
          }
          return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
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
  /**
   * A tag edit, read-modify-write instead of `array_append`.
   *
   * The array operator wrote `leads.tags` without ever reading it, which the
   * mirror cannot follow: the party is the canonical copy and its tags are what
   * the legacy column is derived from. `FOR UPDATE` keeps two concurrent tag
   * edits serialised, which is what the atomic operator bought — taken on the
   * party row now that the party is what the next statement writes.
   */
  private async changeLeadTags(
    orgId: string,
    leadId: number,
    change: (tags: string[]) => string[],
  ): Promise<void> {
    if (!Number.isInteger(leadId)) return;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ tags: businessParties.tags })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, leadId)))
        .limit(1)
        .for("update", { of: businessParties });
      if (!row) return;
      await updateMirroredLeads(tx, orgId, [leadId], { tags: change(row.tags ?? []) });
    });
  }
}
