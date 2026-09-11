import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { WorkflowGraphNode } from "../workflow-graph";
import type {
  NodeExecutionContext,
  NodeExecutionInput,
  NodeOutcome,
  WorkflowNodeExecutor,
} from "../node-outcome";
import { mergedPayload } from "../node-outcome";
import type { AutomationAction } from "../../../../db/schema";

/**
 * Maps each action type to the exact backend permission key the triggering user must hold.
 * Keys are verified against `backend/src/modules/rbac/permissions/` — no invented keys.
 *
 * System context (triggeredBy: null → resolvedPermissions: null) bypasses this map entirely.
 * An action type absent from this map is DENIED by default in user-triggered executions.
 */
const WORKFLOW_ACTION_PERMISSION_REQUIREMENTS: ReadonlyMap<string, string> = new Map([
  ["notify_roles", "notifications:broadcasts:manage"],
  ["notify_all", "notifications:broadcasts:manage"],
  ["email", "settings:automations:manage"],
  ["create_task", "tasks:write"],
  ["webhook", "settings:webhooks:manage"],
  ["support_assign_ticket", "support:tickets:manage"],
  ["support_set_priority", "support:tickets:manage"],
  ["support_add_tag", "support:tags:manage"],
  ["support_internal_note", "support:tickets:internal_note"],
  ["ai_classify", "support:ai:invoke"],
  ["ai_summarize", "support:ai:invoke"],
  ["ai_extract", "support:ai:invoke"],
  ["ai_routing_suggestion", "support:ai:invoke"],
]);

export interface ActionResultLike {
  ok: boolean;
  type: string;
  error?: string;
}

/**
 * A structural port rather than `AutomationActionExecutor` itself, so a test can pass a
 * plain object without a cast; `AutomationActionExecutor` satisfies it as-is.
 */
export interface AutomationActionRunner {
  executeAction(
    orgId: string,
    action: AutomationAction,
    payload: Record<string, unknown>,
  ): Promise<ActionResultLike>;
}

export const AUTOMATION_ACTION_RUNNER = Symbol("AUTOMATION_ACTION_RUNNER");

const actionNodeConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify_roles"),
    config: z.object({
      roles: z.array(z.string()),
      title: z.string(),
      message: z.string(),
      link: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("notify_all"),
    config: z.object({
      title: z.string(),
      message: z.string(),
      link: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("email"),
    config: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  }),
  z.object({
    type: z.literal("create_task"),
    config: z.object({
      title: z.string(),
      assigneeId: z.string().optional(),
      dueInDays: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("webhook"),
    config: z.object({ event: z.string() }),
  }),
  z.object({
    type: z.literal("support_assign_ticket"),
    config: z.object({ assigneeId: z.string() }),
  }),
  z.object({
    type: z.literal("support_set_priority"),
    config: z.object({ priority: z.string() }),
  }),
  z.object({
    type: z.literal("support_add_tag"),
    config: z.object({ tagId: z.number() }),
  }),
  z.object({
    type: z.literal("support_internal_note"),
    config: z.object({ body: z.string() }),
  }),
  z.object({
    type: z.literal("ai_classify"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_summarize"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_extract"),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("ai_routing_suggestion"),
    config: z.record(z.string(), z.unknown()),
  }),
]);

@Injectable()
export class ActionExecutor implements WorkflowNodeExecutor {
  constructor(
    @Inject(AUTOMATION_ACTION_RUNNER)
    private readonly automation: AutomationActionRunner,
  ) {}

  async execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    _now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    const parsed = actionNodeConfigSchema.safeParse(node.data.configuration ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = issue
        ? issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message
        : "invalid configuration";
      return { kind: "failed", error: `Action node is misconfigured (${detail})` };
    }

    if (context.resolvedPermissions !== null) {
      const requiredKey = WORKFLOW_ACTION_PERMISSION_REQUIREMENTS.get(parsed.data.type);
      if (requiredKey === undefined)
        return {
          kind: "failed",
          error: `Action type "${parsed.data.type}" is not permitted in user-triggered workflows`,
        };
      if (!context.resolvedPermissions.has(requiredKey))
        return {
          kind: "failed",
          error: `Action "${parsed.data.type}" requires permission "${requiredKey}" which the triggering user does not hold`,
        };
    }

    const result = await this.automation.executeAction(
      context.orgId,
      parsed.data,
      mergedPayload(input),
    );

    if (!result.ok) {
      return { kind: "failed", error: result.error ?? "Action execution failed" };
    }
    return { kind: "continue", output: { type: result.type } };
  }
}
