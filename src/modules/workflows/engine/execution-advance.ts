import { and, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  workflowExecutions,
  workflowExecutionSteps,
  workflowVersions,
} from "../../../db/schema";
import { nextNodeId, parseWorkflowGraph, type WorkflowGraph } from "./workflow-graph";
import { type NodeDispatchPort } from "./node-outcome";
import { readRunState, writeRunState } from "./workflow-execution-context";
import { type ClaimedExecution } from "./execution-claim";

export const MAX_STEPS_PER_EXECUTION = 200;

export async function advanceExecution(
  tx: TenantTx,
  execution: ClaimedExecution,
  dispatcher: NodeDispatchPort,
): Promise<"completed" | "failed" | "suspended"> {
  const parsed = await loadGraph(tx, execution);
  if (!parsed.ok) {
    await recordStep(tx, execution.id, "definition", "trigger", {
      status: "failed",
      error: parsed.error,
    });
    await finishExecution(tx, execution.id, "failed");
    return "failed";
  }

  const graph = parsed.graph;
  const state = readRunState(execution.context);
  const triggerData = execution.triggerData ?? {};
  let cursor: string | null = state.cursor ?? graph.startNodeId;
  let steps = state.steps;
  const variables = { ...state.variables };

  while (cursor !== null) {
    if (steps >= MAX_STEPS_PER_EXECUTION) {
      await recordStep(tx, execution.id, cursor, "end", {
        status: "failed",
        error: `Exceeded ${MAX_STEPS_PER_EXECUTION} steps; the definition may contain a cycle`,
      });
      await finishExecution(tx, execution.id, "failed");
      return "failed";
    }

    const node = graph.nodesById.get(cursor);
    if (!node) {
      await recordStep(tx, execution.id, cursor, "end", {
        status: "failed",
        error: `Node "${cursor}" is not in the published definition`,
      });
      await finishExecution(tx, execution.id, "failed");
      return "failed";
    }

    const startedAt = new Date();
    const outcome = await dispatcher.execute(
      node,
      { triggerData, variables },
      startedAt,
      {
        orgId: execution.orgId,
        executionId: execution.id,
        userId: execution.triggeredBy,
      },
    );
    steps += 1;

    if (outcome.kind === "failed") {
      await recordStep(tx, execution.id, node.id, node.data.nodeType, {
        status: "failed",
        error: outcome.error,
        startedAt,
      });
      await finishExecution(tx, execution.id, "failed");
      return "failed";
    }

    await recordStep(tx, execution.id, node.id, node.data.nodeType, {
      status: "completed",
      output: outcome.output,
      startedAt,
    });

    if (outcome.kind === "suspend") {
      const next = nextNodeId(graph, node.id);
      if (next === null) {
        await finishExecution(tx, execution.id, "completed", { variables, steps });
        return "completed";
      }
      await tx
        .update(workflowExecutions)
        .set({
          status: "waiting",
          context: writeRunState({
            cursor: next,
            resumeAt: outcome.resumeAt,
            variables,
            steps,
          }),
        })
        .where(
          and(
            eq(workflowExecutions.id, execution.id),
            eq(workflowExecutions.status, "running"),
          ),
        );
      return "suspended";
    }

    if (outcome.kind === "halt") {
      await finishExecution(tx, execution.id, "completed", { variables, steps });
      return "completed";
    }

    cursor = nextNodeId(graph, node.id, outcome.branch);
  }

  await finishExecution(tx, execution.id, "completed", { variables, steps });
  return "completed";
}

async function loadGraph(
  tx: TenantTx,
  execution: ClaimedExecution,
): Promise<{ ok: true; graph: WorkflowGraph } | { ok: false; error: string }> {
  const [version] = await tx
    .select({ definitionJson: workflowVersions.definitionJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.id, execution.workflowVersionId),
        eq(workflowVersions.orgId, execution.orgId),
      ),
    )
    .limit(1);

  if (!version) return { ok: false, error: "Workflow version not found" };
  return parseWorkflowGraph(version.definitionJson);
}

async function recordStep(
  tx: TenantTx,
  executionId: string,
  nodeId: string,
  nodeType: (typeof workflowExecutionSteps.$inferInsert)["nodeType"],
  detail: {
    status: "completed" | "failed";
    output?: Record<string, unknown>;
    error?: string;
    startedAt?: Date;
  },
): Promise<void> {
  const completedAt = new Date();
  const startedAt = detail.startedAt ?? completedAt;
  await tx.insert(workflowExecutionSteps).values({
    executionId,
    nodeId,
    nodeType,
    status: detail.status,
    output: detail.output ?? null,
    error: detail.error ?? null,
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
  });
}

// Scoped to `running` so a cancel landing mid-walk is not overwritten by the terminal write —
// the cancelled row simply no longer matches.
export async function finishExecution(
  tx: TenantTx,
  executionId: string,
  status: "completed" | "failed",
  state?: { variables: Record<string, unknown>; steps: number },
): Promise<void> {
  await tx
    .update(workflowExecutions)
    .set({
      status,
      completedAt: new Date(),
      durationMs: sql`EXTRACT(EPOCH FROM (now() - COALESCE(${workflowExecutions.startedAt}, now()))) * 1000`,
      ...(state
        ? {
            context: writeRunState({
              cursor: null,
              resumeAt: null,
              variables: state.variables,
              steps: state.steps,
            }),
          }
        : {}),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.status, "running"),
      ),
    );
}
