import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import {
  workflowExecutions,
  workflowExecutionSteps,
  workflowVersions,
} from "../../../db/schema";
import { nextNodeId, parseWorkflowGraph, type WorkflowGraph } from "./workflow-graph";
import {
  NODE_DISPATCH_PORT,
  type NodeDispatchPort,
} from "./node-outcome";
import {
  isDue,
  readRunState,
  writeRunState,
  type WorkflowRunState,
} from "./workflow-execution-context";

export const MAX_STEPS_PER_EXECUTION = 200;
export const RUNNING_TIMEOUT_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 50;

export interface WorkflowSweepResult {
  claimed: number;
  completed: number;
  failed: number;
  suspended: number;
}

interface ClaimedExecution {
  id: string;
  orgId: string;
  workflowVersionId: string;
  triggerData: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  triggeredBy: string | null;
}

@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(NODE_DISPATCH_PORT) private readonly dispatcher: NodeDispatchPort,
  ) {}

  async sweep(): Promise<WorkflowSweepResult> {
    const totals: WorkflowSweepResult = {
      claimed: 0,
      completed: 0,
      failed: 0,
      suspended: 0,
    };

    await forEachOrg(this.db, "workflow-runner", async (tx, orgId) => {
      await this.expireStuck(tx, orgId);
      const ids = await this.findRunnableIds(tx, orgId);
      for (const id of ids) {
        const result = await this.runOne(orgId, id);
        if (result === null) continue;
        totals.claimed += 1;
        if (result === "completed") totals.completed += 1;
        else if (result === "failed") totals.failed += 1;
        else totals.suspended += 1;
      }
    });

    return totals;
  }

  private async expireStuck(tx: TenantTx, orgId: string): Promise<void> {
    const cutoff = new Date(Date.now() - RUNNING_TIMEOUT_MS);
    await tx
      .update(workflowExecutions)
      .set({ status: "timed_out", completedAt: new Date() })
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          eq(workflowExecutions.status, "running"),
          lt(workflowExecutions.startedAt, cutoff),
        ),
      );
  }

  private async findRunnableIds(tx: TenantTx, orgId: string): Promise<string[]> {
    const rows = await tx
      .select({
        id: workflowExecutions.id,
        status: workflowExecutions.status,
        context: workflowExecutions.context,
      })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          inArray(workflowExecutions.status, ["pending", "waiting"]),
        ),
      )
      .limit(SWEEP_BATCH);

    const now = new Date();
    return rows
      .filter(
        (row) =>
          row.status === "pending" || isDue(readRunState(row.context), now),
      )
      .map((row) => row.id);
  }

  /**
   * The claim is the status transition itself — `pending|waiting -> running`
   * only succeeds for one caller, so two concurrent sweeps cannot run the same
   * execution and no lock column is needed. A cancel racing the claim wins,
   * because `cancelled` no longer matches the predicate.
   */
  private async claim(
    orgId: string,
    executionId: string,
  ): Promise<ClaimedExecution | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [claimed] = await tx
        .update(workflowExecutions)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(workflowExecutions.id, executionId),
            eq(workflowExecutions.orgId, orgId),
            inArray(workflowExecutions.status, ["pending", "waiting"]),
          ),
        )
        .returning({
          id: workflowExecutions.id,
          orgId: workflowExecutions.orgId,
          workflowVersionId: workflowExecutions.workflowVersionId,
          triggerData: workflowExecutions.triggerData,
          context: workflowExecutions.context,
          triggeredBy: workflowExecutions.triggeredBy,
        });
      return claimed ?? null;
    });
  }

  private async runOne(
    orgId: string,
    executionId: string,
  ): Promise<"completed" | "failed" | "suspended" | null> {
    const execution = await this.claim(orgId, executionId);
    if (!execution) return null;

    try {
      return await runInNewTenantTransaction(this.db, orgId, (tx) =>
        this.advance(tx, execution),
      );
    } catch (error) {
      this.logger.error(
        `workflow execution ${executionId} crashed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await runInNewTenantTransaction(this.db, orgId, (tx) =>
        this.finish(tx, execution.id, "failed"),
      );
      return "failed";
    }
  }

  private async loadGraph(
    tx: TenantTx,
    execution: ClaimedExecution,
  ): Promise<{ ok: true; graph: WorkflowGraph } | { ok: false; error: string }> {
    const [version] = await tx
      .select({ definitionJson: workflowVersions.definitionJson })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, execution.workflowVersionId))
      .limit(1);

    if (!version) return { ok: false, error: "Workflow version not found" };
    return parseWorkflowGraph(version.definitionJson);
  }

  private async advance(
    tx: TenantTx,
    execution: ClaimedExecution,
  ): Promise<"completed" | "failed" | "suspended"> {
    const parsed = await this.loadGraph(tx, execution);
    if (!parsed.ok) {
      await this.recordStep(tx, execution.id, "definition", "trigger", {
        status: "failed",
        error: parsed.error,
      });
      await this.finish(tx, execution.id, "failed");
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
        await this.recordStep(tx, execution.id, cursor, "end", {
          status: "failed",
          error: `Exceeded ${MAX_STEPS_PER_EXECUTION} steps; the definition may contain a cycle`,
        });
        await this.finish(tx, execution.id, "failed");
        return "failed";
      }

      const node = graph.nodesById.get(cursor);
      if (!node) {
        await this.recordStep(tx, execution.id, cursor, "end", {
          status: "failed",
          error: `Node "${cursor}" is not in the published definition`,
        });
        await this.finish(tx, execution.id, "failed");
        return "failed";
      }

      const startedAt = new Date();
      const outcome = await this.dispatcher.execute(
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
        await this.recordStep(tx, execution.id, node.id, node.data.nodeType, {
          status: "failed",
          error: outcome.error,
          startedAt,
        });
        await this.finish(tx, execution.id, "failed");
        return "failed";
      }

      await this.recordStep(tx, execution.id, node.id, node.data.nodeType, {
        status: "completed",
        output: outcome.output,
        startedAt,
      });

      if (outcome.kind === "suspend") {
        const next = nextNodeId(graph, node.id);
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
        await this.finish(tx, execution.id, "completed", { variables, steps });
        return "completed";
      }

      cursor = nextNodeId(graph, node.id, outcome.branch);
    }

    await this.finish(tx, execution.id, "completed", { variables, steps });
    return "completed";
  }

  private async recordStep(
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

  /**
   * Scoped to `running` so a cancel landing mid-walk is not overwritten by the
   * terminal write — the cancelled row simply no longer matches.
   */
  private async finish(
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
}

export type { WorkflowRunState };
