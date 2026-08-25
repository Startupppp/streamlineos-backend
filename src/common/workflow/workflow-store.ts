import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { workflowRuns, workflowSteps } from "../../db/schema";
import { leaseExpiry } from "./retry-policy";
import type { RunLifecycleStore, RunRecord } from "./workflow-runner";
import type { JsonValue, RecordedStep, WorkflowStepStore } from "./workflow.types";

/**
 * Database access for the runner.
 *
 * Deliberately outside row-level security, on the same footing as the outbox it
 * drains: a worker claims across every organisation, so a tenant-scoped policy
 * would make the claim query return nothing. Isolation comes from the layer
 * above — a run is only ever executed against its own organisation, and each of
 * its steps opens that organisation's transaction.
 */

const CLAIMABLE = sql`
  (status IN ('PENDING', 'SLEEPING') AND run_after <= now())
  OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
`;

export function createStepStore(db: Db): WorkflowStepStore {
  return {
    async loadSteps(runId: string): Promise<RecordedStep[]> {
      const rows = await db
        .select({
          stepName: workflowSteps.stepName,
          status: workflowSteps.status,
          output: workflowSteps.output,
        })
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowRunId, runId))
        .orderBy(asc(workflowSteps.startedAt));

      return rows.map((row) => ({
        stepName: row.stepName,
        status: row.status === "FAILED" ? "FAILED" : "COMPLETED",
        output: (row.output ?? null) as JsonValue | null,
      }));
    },

    async recordStep(step): Promise<void> {
      // Upsert: a retried step replaces its earlier failure rather than
      // colliding with the unique name, and a completed one is never rewritten.
      await db
        .insert(workflowSteps)
        .values({
          workflowRunId: step.runId,
          organizationId: step.organizationId,
          stepName: step.stepName,
          status: step.status,
          output: step.output,
          error: step.error,
          attempt: step.attempt,
          completedAt: step.status === "COMPLETED" ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: [
            workflowSteps.organizationId,
            workflowSteps.workflowRunId,
            workflowSteps.stepName,
          ],
          set: {
            status: step.status,
            output: step.output,
            error: step.error,
            attempt: step.attempt,
            completedAt: step.status === "COMPLETED" ? new Date() : null,
          },
        });
    },
  };
}

export function createLifecycleStore(db: Db): RunLifecycleStore {
  return {
    async complete(runId, output, at) {
      await db
        .update(workflowRuns)
        .set({
          status: "COMPLETED",
          output: (output ?? null) as Record<string, unknown> | null,
          completedAt: at,
          leaseExpiresAt: null,
          lastError: null,
        })
        .where(eq(workflowRuns.workflowRunId, runId));
    },

    async suspend(runId, wakeAt) {
      // Released, not held: a multi-day wait costs no worker and survives a deploy.
      await db
        .update(workflowRuns)
        .set({ status: "SLEEPING", runAfter: wakeAt, leaseExpiresAt: null })
        .where(eq(workflowRuns.workflowRunId, runId));
    },

    async retry(runId, attempt, runAfter, error) {
      await db
        .update(workflowRuns)
        .set({ status: "PENDING", attempt, runAfter, leaseExpiresAt: null, lastError: error })
        .where(eq(workflowRuns.workflowRunId, runId));
    },

    async deadLetter(runId, attempt, error, at) {
      await db
        .update(workflowRuns)
        .set({
          status: "DEAD_LETTERED",
          attempt,
          lastError: error,
          deadLetteredAt: at,
          leaseExpiresAt: null,
        })
        .where(eq(workflowRuns.workflowRunId, runId));
    },
  };
}

/**
 * Takes a lease on runs that are due.
 *
 * `SKIP LOCKED` is what lets several workers share the table without
 * coordinating: each takes rows the others are not already holding, instead of
 * queueing behind them. An expired lease is claimable again, which is how a run
 * abandoned by a killed process comes back.
 */
/**
 * How far behind the drain is, if anything is driving it.
 *
 * The runtime deliberately does not schedule itself — the module comment says so
 * — which means it is entirely dependent on something outside calling
 * `/cron/workflow-tick`. When nothing does, a durable workflow claims nothing,
 * runs nothing and reports nothing: a quote sits in its hold window forever, an
 * inbound message is never filed, and every surface says the job is in progress.
 *
 * That is the worst shape a failure can take, because it is indistinguishable
 * from work still happening. This turns it into a number somebody can alert on.
 * It observes and never claims, so calling it cannot itself advance a run and
 * mask the problem it exists to report.
 */
export interface DrainBacklog {
  /** Runs that are due right now and nobody has taken. */
  readonly due: number;
  /** How long the oldest of them has been waiting. Null when nothing is due. */
  readonly oldestDueSeconds: number | null;
}

export async function drainBacklog(db: Db): Promise<DrainBacklog> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS due,
           COALESCE(EXTRACT(EPOCH FROM (now() - min(run_after)))::int, 0) AS oldest
    FROM workflow_runs
    WHERE ${CLAIMABLE}
  `);
  const row = ([...rows][0] ?? {}) as Record<string, unknown>;
  const due = Number(row.due ?? 0);
  return { due, oldestDueSeconds: due > 0 ? Number(row.oldest ?? 0) : null };
}

export async function claimDueRuns(db: Db, limit: number): Promise<RunRecord[]> {
  const lease = leaseExpiry(new Date());

  const claimed = await db.execute(sql`
    UPDATE workflow_runs SET
      status = 'RUNNING',
      lease_expires_at = ${lease},
      updated_at = now()
    WHERE workflow_run_id IN (
      SELECT workflow_run_id FROM workflow_runs
      WHERE ${CLAIMABLE}
      ORDER BY run_after ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING workflow_run_id, organization_id, workflow_name, input, attempt, max_attempts
  `);

  return [...claimed].map((row) => {
    const record = row as Record<string, unknown>;
    return {
      workflowRunId: String(record.workflow_run_id),
      organizationId: String(record.organization_id),
      workflowName: String(record.workflow_name),
      input: (record.input ?? {}) as Record<string, unknown>,
      attempt: Number(record.attempt ?? 0),
      maxAttempts: Number(record.max_attempts ?? 5),
    };
  });
}

export interface StartRunInput {
  readonly organizationId: string;
  readonly workflowName: string;
  readonly input: Record<string, unknown>;
  readonly correlationId?: string | null;
  readonly causationEventId?: string | null;
  readonly maxAttempts?: number;
}

/**
 * Creates a run, or returns the existing one for the same triggering event.
 *
 * A redelivered outbox event must resume the run it already started rather than
 * starting a second — which is the difference between an at-least-once event
 * stream and running a customer's onboarding twice.
 */
export async function startRun(db: Db, input: StartRunInput): Promise<string | null> {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      organizationId: input.organizationId,
      workflowName: input.workflowName,
      input: input.input,
      correlationId: input.correlationId ?? null,
      causationEventId: input.causationEventId ?? null,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    })
    .onConflictDoNothing()
    .returning({ workflowRunId: workflowRuns.workflowRunId });

  if (row) return row.workflowRunId;
  if (!input.causationEventId) return null;

  const [existing] = await db
    .select({ workflowRunId: workflowRuns.workflowRunId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.organizationId, input.organizationId),
        eq(workflowRuns.workflowName, input.workflowName),
        eq(workflowRuns.causationEventId, input.causationEventId),
      ),
    )
    .limit(1);

  return existing?.workflowRunId ?? null;
}
