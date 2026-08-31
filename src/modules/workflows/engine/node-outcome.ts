import type { WorkflowGraphNode } from "./workflow-graph";

export type NodeOutcome =
  | { kind: "continue"; output: Record<string, unknown>; branch?: string }
  | { kind: "suspend"; output: Record<string, unknown>; resumeAt: Date }
  | { kind: "halt"; output: Record<string, unknown> }
  | { kind: "failed"; error: string };

export interface NodeExecutionInput {
  triggerData: Record<string, unknown>;
  variables: Record<string, unknown>;
}

/**
 * Permissions resolved once per execution advance from the triggering user's grants.
 * null means system/scheduled context — all actions are permitted.
 * A Map means user-triggered — each action must appear in this set.
 */
export type ResolvedPermissionSet = ReadonlyMap<string, string> | null;

export interface NodeExecutionContext {
  orgId: string;
  executionId: string;
  userId: string | null;
  resolvedPermissions: ResolvedPermissionSet;
}

/**
 * Executors that need DI (a gateway, a provider client, a sandbox) are Nest
 * providers implementing this; the pure ones stay plain functions in
 * `workflow-node-executors.ts`. Both sides return the same outcome union, so the
 * runner does not care which kind it just called.
 */
export interface WorkflowNodeExecutor {
  execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome>;
}

export interface NodeDispatchPort {
  execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome>;
}

export const NODE_DISPATCH_PORT = Symbol("NODE_DISPATCH_PORT");

export function mergedPayload(
  input: NodeExecutionInput,
): Record<string, unknown> {
  return { ...input.triggerData, ...input.variables };
}
