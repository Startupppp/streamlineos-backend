import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import type { AiNodeType } from "./ai-workflow-nodes/ai-node-types";
import { createHmac } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  AUTOMATION_TRIGGERS,
  organizationMembers,
  tasks,
  webhookEndpoints,
  webhookLogs,
  supportTickets,
  supportTicketMessages,
  supportTicketTags,
  type AutomationAction,
  type AutomationCondition,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { evaluateConditions, type EventPayload } from "./automation.evaluator";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "./dto/automation.schemas";

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

function isValidTrigger(value: string): value is AutomationTrigger {
  return (AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}

interface RuleDefinition {
  id: number;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

export interface ActionResult {
  type: AutomationAction["type"];
  ok: boolean;
  error?: string;
}

export interface EvaluationResult {
  matched: boolean;
  actionResults: ActionResult[];
}

const WEBHOOK_TIMEOUT_MS = 10_000;

function assertNever(x: never): never {
  throw new Error(`Unhandled action type: ${String(x)}`);
}

const AI_ACTION_NODE_MAP: Record<string, AiNodeType> = {
  ai_classify: "classify",
  ai_summarize: "summarize",
  ai_extract: "extract",
  ai_routing_suggestion: "routing_suggestion",
};

@Injectable()
export class AutomationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: AutomationEmailService,
    private readonly planLimits: PlanLimitsService,
    private readonly aiNodeExecutor: AiNodeExecutorService,
  ) {}

  private async notifyMembers(
    orgId: string,
    roles: string[] | null,
    content: { title: string; message: string; link?: string },
  ): Promise<void> {
    const members = await this.db
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    const targets = roles ? members.filter((member) => roles.includes(member.role)) : members;
    if (targets.length === 0) return;

    await Promise.all(
      targets.map((member) =>
        this.notifications.create({
          orgId,
          userId: member.userId,
          title: content.title,
          message: content.message,
          link: content.link,
        }),
      ),
    );
  }

  private async dispatchWebhook(
    orgId: string,
    eventName: string,
    payload: EventPayload,
  ): Promise<void> {
    const endpoints = await this.db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.orgId, orgId), eq(webhookEndpoints.isActive, true)),
    });

    const active = endpoints.filter((endpoint) => {
      const events = endpoint.events;
      return events.length === 0 || events.includes(eventName) || events.includes("*");
    });
    if (active.length === 0) return;

    const results = await Promise.allSettled(
      active.map((endpoint) => this.deliverWebhook(endpoint, orgId, eventName, payload)),
    );

    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) throw new Error(`Webhook delivery failed for ${failed}/${active.length} endpoint(s)`);
  }

  private async deliverWebhook(
    endpoint: { id: number; url: string; secret: string },
    orgId: string,
    eventName: string,
    payload: EventPayload,
  ): Promise<void> {
    const body = JSON.stringify({ event: eventName, data: payload, timestamp: new Date().toISOString() });
    const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");

    let statusCode: number | null = null;
    let responseBody: string | null;
    let success = false;

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StreamlineOS-Signature": `sha256=${signature}`,
          "X-Webhook-Event": eventName,
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      statusCode = response.status;
      responseBody = await response.text().catch(() => null);
      success = response.ok;
    } catch (error) {
      responseBody = error instanceof Error ? error.message : "Request failed";
    }

    await this.db.insert(webhookLogs).values({
      endpointId: endpoint.id,
      orgId,
      event: eventName,
      payload,
      statusCode,
      responseBody: responseBody?.slice(0, 2000) ?? null,
      success,
    });

    if (!success) throw new Error(`Webhook delivery failed: ${statusCode ?? "no response"}`);
  }

  /** support_* actions only make sense for ticket-lifecycle triggers, which always include ticketId in the payload. */
  private requireTicketId(payload: EventPayload): number {
    const ticketId = payload.ticketId;
    if (typeof ticketId !== "number") {
      throw new Error("This action requires a ticketId in the event payload");
    }
    return ticketId;
  }

  async executeAction(
    orgId: string,
    action: AutomationAction,
    payload: EventPayload,
  ): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "notify_roles": {
          await this.notifyMembers(orgId, action.config.roles, {
            title: action.config.title,
            message: action.config.message,
            link: action.config.link,
          });
          return { type: action.type, ok: true };
        }
        case "notify_all": {
          await this.notifyMembers(orgId, null, {
            title: action.config.title,
            message: action.config.message,
            link: action.config.link,
          });
          return { type: action.type, ok: true };
        }
        case "email": {
          await this.email.send({
            to: action.config.to,
            subject: action.config.subject,
            html: action.config.body,
          });
          return { type: action.type, ok: true };
        }
        case "create_task": {
          const dueDate =
            typeof action.config.dueInDays === "number"
              ? new Date(Date.now() + action.config.dueInDays * 24 * 60 * 60 * 1000)
              : null;
          await this.db.insert(tasks).values({
            orgId,
            title: action.config.title,
            assigneeId: action.config.assigneeId ?? null,
            dueDate,
          });
          return { type: action.type, ok: true };
        }
        case "webhook": {
          await this.dispatchWebhook(orgId, action.config.event, payload);
          return { type: action.type, ok: true };
        }
        case "support_assign_ticket": {
          const ticketId = this.requireTicketId(payload);
          await this.db
            .update(supportTickets)
            .set({ assigneeId: action.config.assigneeId, updatedAt: new Date() })
            .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
          return { type: action.type, ok: true };
        }
        case "support_set_priority": {
          const ticketId = this.requireTicketId(payload);
          await this.db
            .update(supportTickets)
            .set({ priority: action.config.priority as (typeof supportTickets.$inferInsert)["priority"], updatedAt: new Date() })
            .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
          return { type: action.type, ok: true };
        }
        case "support_add_tag": {
          const ticketId = this.requireTicketId(payload);
          await this.db
            .insert(supportTicketTags)
            .values({ ticketId, tagId: action.config.tagId })
            .onConflictDoNothing();
          return { type: action.type, ok: true };
        }
        case "support_internal_note": {
          const ticketId = this.requireTicketId(payload);
          await this.db.insert(supportTicketMessages).values({
            ticketId,
            authorId: null,
            body: action.config.body,
            isInternal: true,
            sourceChannel: "internal",
          });
          return { type: action.type, ok: true };
        }
        case "ai_classify":
        case "ai_summarize":
        case "ai_extract":
        case "ai_routing_suggestion": {
          const nodeType = AI_ACTION_NODE_MAP[action.type];
          if (!nodeType) return { type: action.type, ok: false, error: "Unknown AI node type" };
          const result = await this.aiNodeExecutor.executeNode(
            orgId,
            "system",
            nodeType,
            action.config,
            payload,
          );
          return { type: action.type, ok: result.ok, error: result.error };
        }
        default:
          return assertNever(action);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action execution failed";
      return { type: action.type, ok: false, error: message };
    }
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

      for (const rule of rules) {
        try {
          const { matched, actionResults } = await this.runRule(orgId, rule, payload);

          if (!matched) {
            await this.db.insert(automationRuns).values({
              orgId,
              ruleId: rule.id,
              triggerEvent,
              status: "skipped",
              payload,
            });
            continue;
          }

          const failures = actionResults.filter((result) => !result.ok);
          await this.db
            .update(automationRules)
            .set({ runCount: sql`${automationRules.runCount} + 1`, lastRunAt: new Date() })
            .where(eq(automationRules.id, rule.id));

          await this.db.insert(automationRuns).values({
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
          });
        } catch (error) {
          logger.error("automation rule execution failed", { orgId, ruleId: rule.id, triggerEvent, error });
        }
      }
    } catch (error) {
      logger.error("runAutomationsForEvent failed", { orgId, triggerEvent, error });
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
