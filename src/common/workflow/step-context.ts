import {
  WorkflowSuspended,
  type JsonValue,
  type RecordedStep,
  type StepContext,
  type WorkflowStepStore,
} from "./workflow.types";

export interface StepContextOptions {
  readonly runId: string;
  readonly organizationId: string;
  readonly attempt: number;
  readonly store: WorkflowStepStore;
  readonly now?: () => Date;
  /**
   * Wraps a step's body together with the recording of its result.
   *
   * The runner supplies a tenant-scoped transaction here, which buys two
   * things: the step's queries carry the organisation GUC, and the work and the
   * memo of it commit atomically — so a crash between them cannot leave a
   * charge taken with no record that it was.
   *
   * Defaults to running the body directly, which is the unit-test path.
   */
  readonly withinStep?: <T>(stepName: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Builds the step API for one attempt at a run.
 *
 * Loads what previous attempts recorded, then replays: a step already recorded
 * returns its stored output immediately, and only the first step past the
 * recorded frontier actually executes. That is the whole resume mechanism.
 */
export async function createStepContext(options: StepContextOptions): Promise<StepContext> {
  const { runId, organizationId, attempt, store } = options;
  const now = options.now ?? (() => new Date());
  const withinStep = options.withinStep ?? (<T>(_name: string, fn: () => Promise<T>) => fn());

  const recorded = new Map<string, RecordedStep>();
  for (const step of await store.loadSteps(runId)) recorded.set(step.stepName, step);

  // Names must be unique within a run or two different steps would share one
  // memo, and the second would silently return the first's result.
  const seen = new Set<string>();
  const claimName = (name: string): void => {
    if (!name) throw new Error("workflow step: name must be a non-empty string");
    if (seen.has(name))
      throw new Error(
        `workflow step: "${name}" used twice in run ${runId}. Step names identify a memo, so they must be unique within a workflow.`,
      );
    seen.add(name);
  };

  return {
    runId,
    organizationId,
    attempt,

    async run<T extends JsonValue | void>(name: string, fn: () => Promise<T>): Promise<T> {
      claimName(name);

      const previous = recorded.get(name);
      if (previous?.status === "COMPLETED") return previous.output as T;

      // A step that failed before is retried: the failure was recorded for
      // inspection, not as a permanent verdict.
      try {
        return await withinStep(name, async () => {
          const output = await fn();

          await store.recordStep({
            runId,
            organizationId,
            stepName: name,
            status: "COMPLETED",
            output: (output ?? null) as JsonValue | null,
            error: null,
            attempt,
          });

          return output;
        });
      } catch (error) {
        // Recorded outside the step's own transaction, which has rolled back —
        // otherwise the record of the failure would roll back with it.
        await store.recordStep({
          runId,
          organizationId,
          stepName: name,
          status: "FAILED",
          output: null,
          error: error instanceof Error ? error.message : String(error),
          attempt,
        });
        throw error;
      }
    },

    async sleep(name: string, ms: number): Promise<void> {
      claimName(name);

      // A sleep that already elapsed is a completed step, so a resumed run walks
      // straight past it rather than waiting the duration again.
      if (recorded.get(name)?.status === "COMPLETED") return;

      const wakeAt = new Date(now().getTime() + Math.max(0, ms));

      await store.recordStep({
        runId,
        organizationId,
        stepName: name,
        status: "COMPLETED",
        output: { wakeAt: wakeAt.toISOString() },
        error: null,
        attempt,
      });

      throw new WorkflowSuspended(wakeAt);
    },
  };
}
