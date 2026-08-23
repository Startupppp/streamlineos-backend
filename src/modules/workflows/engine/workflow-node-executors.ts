import { z } from "zod";
import {
  evaluateNormalizedCondition,
  evaluateNormalizedConditions,
  type NormalizedCondition,
} from "../../automation/shared-condition-evaluator";
import type { WorkflowGraphNode, WorkflowNodeType } from "./workflow-graph";

export const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

export type NodeOutcome =
  | { kind: "continue"; output: Record<string, unknown>; branch?: string }
  | { kind: "suspend"; output: Record<string, unknown>; resumeAt: Date }
  | { kind: "halt"; output: Record<string, unknown> }
  | { kind: "failed"; error: string };

export interface NodeExecutionInput {
  triggerData: Record<string, unknown>;
  variables: Record<string, unknown>;
}

const conditionConfigSchema = z.object({
  conditions: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum([
          "eq",
          "neq",
          "contains",
          "gt",
          "lt",
          "gte",
          "lte",
          "in",
          "exists",
          "changed_to",
        ]),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
          .optional(),
      }),
    )
    .min(1),
  match: z.enum(["all", "any"]).optional(),
});

const delayConfigSchema = z
  .object({
    ms: z.number().int().positive().optional(),
    seconds: z.number().int().positive().optional(),
    minutes: z.number().int().positive().optional(),
    hours: z.number().int().positive().optional(),
  })
  .refine(
    (cfg) =>
      cfg.ms !== undefined ||
      cfg.seconds !== undefined ||
      cfg.minutes !== undefined ||
      cfg.hours !== undefined,
    { message: "one of ms, seconds, minutes or hours is required" },
  );

function delayMillis(config: z.infer<typeof delayConfigSchema>): number {
  return (
    (config.ms ?? 0) +
    (config.seconds ?? 0) * 1000 +
    (config.minutes ?? 0) * 60_000 +
    (config.hours ?? 0) * 3_600_000
  );
}

function configOf(node: WorkflowGraphNode): Record<string, unknown> {
  return node.data.configuration ?? {};
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid configuration";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function executeCondition(
  node: WorkflowGraphNode,
  input: NodeExecutionInput,
  now: Date,
): NodeOutcome {
  const parsed = conditionConfigSchema.safeParse(configOf(node));
  if (!parsed.success)
    return {
      kind: "failed",
      error: `Condition node is misconfigured (${firstIssue(parsed.error)})`,
    };

  const payload: Record<string, unknown> = {
    ...input.triggerData,
    ...input.variables,
  };
  const conditions: NormalizedCondition[] = parsed.data.conditions;
  const matched =
    parsed.data.match === "any"
      ? conditions.some((condition) =>
          evaluateNormalizedCondition(condition, payload),
        )
      : evaluateNormalizedConditions(conditions, payload);

  return {
    kind: "continue",
    output: { matched, evaluatedAt: now.toISOString() },
    branch: matched ? "true" : "false",
  };
}

function executeDelay(node: WorkflowGraphNode, now: Date): NodeOutcome {
  const parsed = delayConfigSchema.safeParse(configOf(node));
  if (!parsed.success)
    return {
      kind: "failed",
      error: `Delay node is misconfigured (${firstIssue(parsed.error)})`,
    };

  const millis = delayMillis(parsed.data);
  if (millis > MAX_DELAY_MS)
    return {
      kind: "failed",
      error: `Delay of ${millis}ms exceeds the ${MAX_DELAY_MS}ms maximum`,
    };

  const resumeAt = new Date(now.getTime() + millis);
  return {
    kind: "suspend",
    output: { resumeAt: resumeAt.toISOString(), delayMs: millis },
    resumeAt,
  };
}

const UNIMPLEMENTED: Partial<Record<WorkflowNodeType, string>> = {
  approval: "approval routing",
  action: "action dispatch",
  loop: "iteration",
  ai_action: "the credit-metered AI gateway",
  integration: "third-party calls through Composio",
  script: "a sandboxed script runtime",
};

export function executeNode(
  node: WorkflowGraphNode,
  input: NodeExecutionInput,
  now: Date,
): NodeOutcome {
  switch (node.data.nodeType) {
    case "trigger":
      return { kind: "continue", output: { triggerData: input.triggerData } };
    case "condition":
      return executeCondition(node, input, now);
    case "delay":
      return executeDelay(node, now);
    case "end":
      return { kind: "halt", output: { variables: input.variables } };
    default: {
      const missing = UNIMPLEMENTED[node.data.nodeType];
      return {
        kind: "failed",
        error: `Node type "${node.data.nodeType}" has no executor yet — it needs ${missing ?? "an implementation"}. The execution is failed rather than left pending.`,
      };
    }
  }
}
