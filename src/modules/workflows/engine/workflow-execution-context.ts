import { z } from "zod";

/**
 * Runner state rides in `workflow_executions.context` because the table has no
 * cursor/resume columns and the migration tooling is mid-repair. `cursor` is the
 * node to run next; `resumeAt` is set only while the execution is `waiting`.
 * `infraAttempt` tracks transient infrastructure failures (Redis, network) so
 * the runner can distinguish retryable blips from terminal domain errors.
 */
const executionContextSchema = z.object({
  cursor: z.string().nullish(),
  resumeAt: z.string().nullish(),
  variables: z.record(z.string(), z.unknown()).optional(),
  steps: z.number().int().nonnegative().optional(),
  infraAttempt: z.number().int().nonnegative().optional(),
});

export interface WorkflowRunState {
  cursor: string | null;
  resumeAt: Date | null;
  variables: Record<string, unknown>;
  steps: number;
  /** How many times this execution has been released back due to transient infra errors. */
  infraAttempt: number;
}

export function readRunState(context: unknown): WorkflowRunState {
  const parsed = executionContextSchema.safeParse(context ?? {});
  if (!parsed.success)
    return { cursor: null, resumeAt: null, variables: {}, steps: 0, infraAttempt: 0 };

  const resumeAt = parsed.data.resumeAt ? new Date(parsed.data.resumeAt) : null;
  return {
    cursor: parsed.data.cursor ?? null,
    resumeAt: resumeAt && !Number.isNaN(resumeAt.getTime()) ? resumeAt : null,
    variables: parsed.data.variables ?? {},
    steps: parsed.data.steps ?? 0,
    infraAttempt: parsed.data.infraAttempt ?? 0,
  };
}

export function writeRunState(state: WorkflowRunState): Record<string, unknown> {
  return {
    cursor: state.cursor,
    resumeAt: state.resumeAt ? state.resumeAt.toISOString() : null,
    variables: state.variables,
    steps: state.steps,
    infraAttempt: state.infraAttempt,
  };
}

export function isDue(state: WorkflowRunState, now: Date): boolean {
  return state.resumeAt !== null && state.resumeAt.getTime() <= now.getTime();
}
