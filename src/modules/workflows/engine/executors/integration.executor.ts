import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type {
  NodeExecutionContext,
  NodeExecutionInput,
  NodeOutcome,
  WorkflowNodeExecutor,
} from "../node-outcome";
import type { WorkflowGraphNode } from "../workflow-graph";

export const INTEGRATION_LOOKUP = Symbol("INTEGRATION_LOOKUP");
export const COMPOSIO_TOOL_CALLER = Symbol("COMPOSIO_TOOL_CALLER");

export interface IntegrationLookup {
  listConnections(
    orgId: string,
    userId: string,
  ): PromiseLike<
    ReadonlyArray<{
      id: number;
      status: string;
      toolkit: string;
      isPrimary: boolean;
    }>
  >;
  ownedConnection(
    orgId: string,
    userId: string,
    connectionId: number,
  ): Promise<{ composioConnectedAccountId: string }>;
}

export interface ComposioToolCaller {
  executeTool(
    slug: string,
    userId: string,
    args: Record<string, unknown>,
    connectedAccountId: string,
  ): Promise<unknown>;
}

const TOOL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 65_536;

const integrationNodeConfigSchema = z.object({
  toolkit: z.string().min(1),
  action: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function sanitizeProviderResponse(raw: unknown): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? "null";
  } catch {
    return { error: "Provider response is not JSON-serializable" };
  }
  if (serialized.length > MAX_OUTPUT_BYTES)
    return { truncated: true, preview: serialized.slice(0, MAX_OUTPUT_BYTES) };
  const parsed: unknown = JSON.parse(serialized);
  if (isRecord(parsed)) return parsed;
  return { data: parsed };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`Integration call timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (handle !== undefined) clearTimeout(handle);
  });
}

@Injectable()
export class WorkflowIntegrationExecutor implements WorkflowNodeExecutor {
  constructor(
    @Inject(INTEGRATION_LOOKUP) private readonly integrations: IntegrationLookup,
    @Inject(COMPOSIO_TOOL_CALLER) private readonly caller: ComposioToolCaller,
  ) {}

  async execute(
    node: WorkflowGraphNode,
    _input: NodeExecutionInput,
    _now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    const parsed = integrationNodeConfigSchema.safeParse(
      node.data.configuration ?? {},
    );
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return {
        kind: "failed",
        error: `integration node misconfigured: ${firstIssue?.message ?? "validation failed"}`,
      };
    }

    const { toolkit, action, arguments: args } = parsed.data;

    if (!context.userId)
      return { kind: "failed", error: "Integration node requires a user context" };

    const userId = context.userId;
    const connections = await this.integrations.listConnections(context.orgId, userId);
    const active = connections.filter(
      (c) => c.toolkit === toolkit && c.status === "active",
    );
    const connection = active.find((c) => c.isPrimary) ?? active[0];

    if (!connection)
      return {
        kind: "failed",
        error: `No active ${toolkit} connection found for this organisation`,
      };

    let composioAccountId: string;
    try {
      const owned = await this.integrations.ownedConnection(
        context.orgId,
        userId,
        connection.id,
      );
      composioAccountId = owned.composioConnectedAccountId;
    } catch {
      return { kind: "failed", error: `Could not resolve ${toolkit} connection` };
    }

    let raw: unknown;
    try {
      raw = await withTimeout(
        this.caller.executeTool(action, userId, args, composioAccountId),
        TOOL_TIMEOUT_MS,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Integration call failed";
      return { kind: "failed", error: message };
    }

    return { kind: "continue", output: sanitizeProviderResponse(raw) };
  }
}
