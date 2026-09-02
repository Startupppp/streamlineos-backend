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

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
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
