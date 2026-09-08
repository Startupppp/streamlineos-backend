import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  organizationMembers,
  workflowExecutions,
  workflowExecutionSteps,
  workflowVersions,
} from "../../../db/schema";
import {
  nextNodeId,
  parseWorkflowGraph,
  type WorkflowGraph,
} from "./workflow-graph";
import {
  type NodeDispatchPort,
  type ResolvedPermissionSet,
} from "./node-outcome";
import { readRunState, writeRunState, type WorkflowRunState } from "./workflow-execution-context";
import { type ClaimedExecution } from "./execution-claim";

export const MAX_STEPS_PER_EXECUTION = 200;

async function isStillRunning(
  tx: TenantTx,
  orgId: string,
  executionId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ executionStatus: workflowExecutions.status })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.orgId, orgId),
      ),
    )
    .limit(1);
  return row?.executionStatus === "running";
}

async function assertTriggerActorActive(
  tx: TenantTx,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: organizationMembers.status })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .limit(1);
  return row?.status === "ACTIVE";
}

export async function advanceExecution(
  tx: TenantTx,
  execution: ClaimedExecution,
  dispatcher: NodeDispatchPort,
  resolvedPermissions: ResolvedPermissionSet = null,
): Promise<"completed" | "failed" | "suspended"> {
  if (execution.triggeredBy != null) {
    const actorActive = await assertTriggerActorActive(
      tx,
      execution.orgId,
      execution.triggeredBy,
    );
    if (!actorActive) {
      await recordStep(
        tx,
        execution.orgId,
        execution.id,
        "authority-check",
        "trigger",
        {
          status: "failed",
          error:
            "Execution actor is no longer an active member of this organisation",
        },
      );
      await finishExecution(tx, execution.orgId, execution.id, "failed");
      return "failed";
    }
  }

  const parsed = await loadGraph(tx, execution);
  if (!parsed.ok) {
    await recordStep(
      tx,
      execution.orgId,
      execution.id,
      "definition",
      "trigger",
      {
        status: "failed",
        error: parsed.error,
      },
    );
    await finishExecution(tx, execution.orgId, execution.id, "failed");
    return "failed";
  }

  const graph = parsed.graph;
  const state = readRunState(execution.context);
  const triggerData = execution.triggerData ?? {};
  let cursor: string | null = state.cursor ?? graph.startNodeId;
  let steps = state.steps;
  const variables = { ...state.variables };

  while (cursor !== null) {
    if (!(await isStillRunning(tx, execution.orgId, execution.id))) {
      await tx
        .update(workflowExecutions)
        .set({ context: writeRunState({ ...state, cursor, variables, steps }) })
        .where(
          and(
            eq(workflowExecutions.id, execution.id),
            eq(workflowExecutions.orgId, execution.orgId),
          ),
        );
      return "suspended";
    }

    if (steps >= MAX_STEPS_PER_EXECUTION) {
      await recordStep(tx, execution.orgId, execution.id, cursor, "end", {
        status: "failed",
        error: `Exceeded ${MAX_STEPS_PER_EXECUTION} steps; the definition may contain a cycle`,
      });
      await finishExecution(tx, execution.orgId, execution.id, "failed");
      return "failed";
    }

    const node = graph.nodesById.get(cursor);
    if (!node) {
      await recordStep(tx, execution.orgId, execution.id, cursor, "end", {
        status: "failed",
        error: `Node "${cursor}" is not in the published definition`,
      });
      await finishExecution(tx, execution.orgId, execution.id, "failed");
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
        resolvedPermissions,
      },
    );
    steps += 1;

    if (outcome.kind === "failed") {
      await recordStep(
        tx,
        execution.orgId,
        execution.id,
        node.id,
        node.data.nodeType,
        {
          status: "failed",
          error: outcome.error,
          startedAt,
        },
      );
      await finishExecution(tx, execution.orgId, execution.id, "failed");
      return "failed";
    }

    await recordStep(
      tx,
      execution.orgId,
      execution.id,
      node.id,
      node.data.nodeType,
      {
        status: "completed",
        output: outcome.output,
        startedAt,
      },
    );

    if (outcome.kind === "suspend") {
      const next = nextNodeId(graph, node.id);
      if (next === null) {
        await finishExecution(tx, execution.orgId, execution.id, "completed", {
          variables,
          steps,
        });
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
            infraAttempt: 0,
            dlqReason: null,
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
      await finishExecution(tx, execution.orgId, execution.id, "completed", {
        variables,
        steps,
      });
      return "completed";
    }

    cursor = nextNodeId(graph, node.id, outcome.branch);
  }

  await finishExecution(tx, execution.orgId, execution.id, "completed", { variables, steps });
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
  orgId: string,
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
    orgId,
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
  orgId: string,
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
              infraAttempt: 0,
              dlqReason: null,
            }),
          }
        : {}),
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.orgId, orgId),
        eq(workflowExecutions.status, "running"),
      ),
    );
}

interface DeadLetterWrite {
  readonly status: "dead_lettered";
  readonly dlqReason: string;
  readonly completedAt: Date;
  readonly durationMs: SQL;
  readonly context: Record<string, unknown>;
}

const DEAD_LETTER_COLUMNS: Record<keyof DeadLetterWrite, AnyPgColumn> = {
  status: workflowExecutions.status,
  dlqReason: workflowExecutions.dlqReason,
  completedAt: workflowExecutions.completedAt,
  durationMs: workflowExecutions.durationMs,
  context: workflowExecutions.context,
};

function deadLetterDurationMs(): SQL {
  return sql`EXTRACT(EPOCH FROM (now() - COALESCE(${workflowExecutions.startedAt}, now()))) * 1000`;
}

function deadLetterWrite(reason: string, state: WorkflowRunState): DeadLetterWrite {
  return {
    status: "dead_lettered",
    dlqReason: reason,
    completedAt: new Date(),
    durationMs: deadLetterDurationMs(),
    context: writeRunState({ ...state, cursor: null, resumeAt: null, dlqReason: reason }),
  };
}

interface DeadLetterCell {
  readonly column: AnyPgColumn;
  readonly value: unknown;
}

function deadLetterCells(write: DeadLetterWrite): readonly DeadLetterCell[] {
  return [
    { column: DEAD_LETTER_COLUMNS.status, value: write.status },
    { column: DEAD_LETTER_COLUMNS.dlqReason, value: write.dlqReason },
    { column: DEAD_LETTER_COLUMNS.completedAt, value: write.completedAt },
    { column: DEAD_LETTER_COLUMNS.context, value: write.context },
  ];
}

function deadLetterParam(column: AnyPgColumn, value: unknown): SQL {
  return sql`${sql.param(value, column)}::${sql.raw(column.getSQLType())}`;
}

function assertDistinctExecutions(rows: ReadonlyArray<{ id: string }>): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id))
      throw new Error(`deadLetterExecutions: execution ${row.id} appears twice in one batch`);
    seen.add(row.id);
  }
}

export async function deadLetterExecution(
  tx: TenantTx,
  orgId: string,
  executionId: string,
  reason: string,
  state: WorkflowRunState,
): Promise<void> {
  await tx
    .update(workflowExecutions)
    .set(deadLetterWrite(reason, state))
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.orgId, orgId),
        eq(workflowExecutions.status, "running"),
      ),
    );
}

export interface DeadLetterTarget {
  readonly executionId: string;
  readonly reason: string;
  readonly state: WorkflowRunState;
}

export async function deadLetterExecutions(
  tx: TenantTx,
  orgId: string,
  targets: readonly DeadLetterTarget[],
): Promise<void> {
  if (targets.length === 0) return;

  const rows = targets.map((target) => ({
    id: target.executionId,
    cells: deadLetterCells(deadLetterWrite(target.reason, target.state)),
  }));
  const first = rows[0];
  if (first === undefined) return;
  assertDistinctExecutions(rows);

  const keyColumn = workflowExecutions.id;
  const tuples = sql.join(
    rows.map((row) => {
      const cells = row.cells.map((cell) => deadLetterParam(cell.column, cell.value));
      return sql`(${sql.join([deadLetterParam(keyColumn, row.id), ...cells], sql`, `)})`;
    }),
    sql`, `,
  );
  const aliasColumns = sql.join(
    [keyColumn, ...first.cells.map((cell) => cell.column)].map((column) =>
      sql.identifier(column.name),
    ),
    sql`, `,
  );
  const assignments = sql.join(
    [
      ...first.cells.map(
        (cell) => sql`${sql.identifier(cell.column.name)} = v.${sql.identifier(cell.column.name)}`,
      ),
      sql`${sql.identifier(DEAD_LETTER_COLUMNS.durationMs.name)} = ${deadLetterDurationMs()}`,
    ],
    sql`, `,
  );

  await tx.execute(sql`
    UPDATE ${workflowExecutions}
    SET ${assignments}
    FROM (VALUES ${tuples}) AS v(${aliasColumns})
    WHERE ${keyColumn} = v.${sql.identifier(keyColumn.name)}
      AND ${eq(workflowExecutions.orgId, orgId)}
      AND ${eq(workflowExecutions.status, "running")}
  `);
}
