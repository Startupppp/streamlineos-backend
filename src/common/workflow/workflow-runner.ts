import { describeDatabaseCause } from "../db/postgres-error";
import { createStepContext } from "./step-context";
import { decideAfterFailure } from "./retry-policy";
import type { WorkflowRegistry } from "./workflow-registry";
import {
  isSuspension,
  type JsonValue,
  type StepContext,
  type WorkflowStepStore,
} from "./workflow.types";

export interface RunRecord {
  readonly workflowRunId: string;
  readonly organizationId: string;
  readonly workflowName: string;
  readonly input: Record<string, unknown>;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** What the producer persisted, so the drain can report under it. */
  readonly correlationId?: string | null;
  /** The lease_expires_at value set during claim — used to fence terminal writes. */
  readonly leaseExpiresAt: Date;
}

export interface RunLifecycleStore {
  complete(runId: string, output: JsonValue | null, at: Date): Promise<void>;
  suspend(runId: string, wakeAt: Date): Promise<void>;
  retry(runId: string, attempt: number, runAfter: Date, error: string): Promise<void>;
  deadLetter(runId: string, attempt: number, error: string, at: Date): Promise<void>;
}

export type RunOutcome = "completed" | "suspended" | "retry" | "dead-lettered";

export interface ExecuteRunDeps {
  readonly run: RunRecord;
  readonly registry: WorkflowRegistry;
  readonly steps: WorkflowStepStore;
  readonly lifecycle: RunLifecycleStore;
  readonly now?: () => Date;
  /** Supplied by the service as a tenant-scoped transaction; see StepContextOptions. */
  readonly withinStep?: <T>(stepName: string, fn: () => Promise<T>) => Promise<T>;
  readonly onError?: (error: unknown, run: RunRecord) => void;
}

/**
 * What a dead-lettered run says about itself, which is the only account of the
 * failure anybody gets.
 *
 * `error.stack` alone was not one. Drizzle wraps a driver error in
 * `DrizzleQueryError`, whose message is `Failed query: <the whole statement>`
 * followed by the bound parameters -- so a failing 60-column insert recorded
 * sixty column names, sixty values, and no reason. The SQLSTATE, the constraint
 * and PostgreSQL's own sentence are all one level down on `.cause`, which
 * nothing walked. An operator opening `workflow_runs.last_error` could see
 * exactly which row was refused and never why.
 *
 * Appended rather than substituted: the statement is still how you find the
 * call site, and the cause is what tells you what to do about it. A failure with
 * no driver error underneath is left byte-for-byte as it was.
 */
function describe(error: unknown): string {
  const base = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const cause = describeDatabaseCause(error);
  return cause === null ? base : `${base}\n  caused by: ${cause}`;
}

/**
 * Runs one attempt at one workflow run and records what happened.
 *
 * The workflow body is re-executed from the top every attempt; the step context
 * is what makes that cheap, returning recorded results for everything already
 * done. Four outcomes, and each is written down before this returns — a run
 * whose fate is only held in memory is a run lost to the next restart.
 */
export async function executeRun(deps: ExecuteRunDeps): Promise<RunOutcome> {
  const { run, registry, steps, lifecycle } = deps;
  const now = deps.now ?? (() => new Date());
  const attempt = run.attempt + 1;

  const definition = registry.get(run.workflowName);
  if (!definition) {
    // Not retryable: no amount of waiting makes a handler appear, so spending
    // five attempts discovering that only delays the alert.
    const message = `workflow "${run.workflowName}" is not registered in this deployment`;
    await lifecycle.deadLetter(run.workflowRunId, attempt, message, now());
    deps.onError?.(new Error(message), run);
    return "dead-lettered";
  }

  let step: StepContext;
  try {
    step = await createStepContext({
      runId: run.workflowRunId,
      organizationId: run.organizationId,
      attempt,
      store: steps,
      now,
      withinStep: deps.withinStep,
    });
  } catch (error) {
    return failed(error);
  }

  try {
    const output = await definition.handler(step, {
      runId: run.workflowRunId,
      organizationId: run.organizationId,
      attempt,
      input: run.input,
    });

    await lifecycle.complete(run.workflowRunId, (output ?? null) as JsonValue | null, now());
    return "completed";
  } catch (error) {
    if (isSuspension(error)) {
      // Healthy: the run asked to wait, and is released so the worker is free.
      await lifecycle.suspend(run.workflowRunId, error.wakeAt);
      return "suspended";
    }
    return failed(error);
  }

  async function failed(error: unknown): Promise<RunOutcome> {
    deps.onError?.(error, run);

    const decision = decideAfterFailure({
      attempt,
      maxAttempts: definition?.maxAttempts ?? run.maxAttempts,
      now: now(),
    });

    if (decision.kind === "dead-letter") {
      await lifecycle.deadLetter(run.workflowRunId, attempt, describe(error), now());
      return "dead-lettered";
    }

    await lifecycle.retry(run.workflowRunId, attempt, decision.runAfter, describe(error));
    return "retry";
  }
}
