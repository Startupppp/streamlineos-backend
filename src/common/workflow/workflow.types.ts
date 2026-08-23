/**
 * The durable step API a workflow is written against.
 *
 * A workflow body is re-executed from the top on every attempt. What makes that
 * safe is that `step.run` returns a previously recorded result instead of
 * calling the function again — so the code reads like a straight-line procedure
 * while actually being a resumable state machine.
 *
 * The consequence a workflow author must respect: everything with an effect
 * belongs inside a step. Code between steps runs again on every attempt.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface StepContext {
  /**
   * Runs `fn` once for the lifetime of the run and records its result. On a
   * later attempt the recorded value is returned without calling `fn`.
   */
  run<T extends JsonValue | void>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Suspends the run until the duration has elapsed. Not a timer held in
   * memory — the run is released and re-claimed later, so a sleep survives a
   * deploy, and a multi-day wait costs nothing while it waits.
   */
  sleep(name: string, ms: number): Promise<void>;

  /** The run this is executing, for logging and for a step that needs its own id. */
  readonly runId: string;
  readonly organizationId: string;
  readonly attempt: number;
}

export interface WorkflowRunContext {
  readonly runId: string;
  readonly organizationId: string;
  readonly attempt: number;
  readonly input: Record<string, unknown>;
}

export type WorkflowHandler = (
  step: StepContext,
  context: WorkflowRunContext,
) => Promise<JsonValue | void>;

export interface WorkflowDefinition {
  readonly name: string;
  /** Outbox event types that start this workflow. */
  readonly triggers?: readonly string[];
  readonly maxAttempts?: number;
  readonly handler: WorkflowHandler;
}

export interface RecordedStep {
  readonly stepName: string;
  readonly status: "COMPLETED" | "FAILED";
  readonly output: JsonValue | null;
}

/**
 * Storage the step context needs, narrowed to what it actually uses.
 *
 * A port rather than the database directly, so the memoisation rules — the part
 * that decides whether real work runs a second time — are testable without a
 * database standing up.
 */
export interface WorkflowStepStore {
  loadSteps(runId: string): Promise<RecordedStep[]>;
  recordStep(step: {
    runId: string;
    organizationId: string;
    stepName: string;
    status: "COMPLETED" | "FAILED";
    output: JsonValue | null;
    error: string | null;
    attempt: number;
  }): Promise<void>;
}

/**
 * Thrown to unwind out of a workflow body when a step sleeps.
 *
 * Not an error condition: the run is healthy and will be picked up again after
 * `wakeAt`. It is an exception only because that is how you abandon a
 * partially-executed function without the author writing a return path.
 */
export class WorkflowSuspended extends Error {
  constructor(readonly wakeAt: Date) {
    super(`workflow suspended until ${wakeAt.toISOString()}`);
    this.name = "WorkflowSuspended";
  }
}

export function isSuspension(error: unknown): error is WorkflowSuspended {
  return error instanceof WorkflowSuspended;
}
