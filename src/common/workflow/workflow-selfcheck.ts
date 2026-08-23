import type { WorkflowDefinition } from "./workflow.types";

export const SELFCHECK_WORKFLOW_NAME = "runtime.selfcheck";

/**
 * Proves the runtime works, in whatever environment it is running.
 *
 * Several steps and a sleep, so a single run exercises the properties that
 * matter and that nothing else demonstrates end to end: each step is recorded
 * and skipped on a later attempt, and the sleep releases the run rather than
 * holding a worker.
 *
 * Kill the process between ticks and the run resumes at the step after the last
 * recorded one — the recorded `startedAt` timestamps show which attempt each
 * step actually ran on.
 *
 * Not registered in production. It writes nothing outside its own step records,
 * but a workflow whose only purpose is to be run by an operator has no business
 * being startable against real tenants.
 */
export const selfcheckWorkflow: WorkflowDefinition = {
  name: SELFCHECK_WORKFLOW_NAME,
  maxAttempts: 3,
  handler: async (step, context) => {
    const first = await step.run("first", async () => ({
      ranOnAttempt: context.attempt,
      at: new Date().toISOString(),
    }));

    await step.sleep("pause", 5_000);

    const second = await step.run("second", async () => ({
      ranOnAttempt: context.attempt,
      // Equal to the first only if the run never suspended, which would mean
      // the sleep did not release it.
      resumedAfterSleep: context.attempt !== first.ranOnAttempt,
    }));

    return {
      organizationId: context.organizationId,
      first,
      second,
      finishedOnAttempt: context.attempt,
    };
  },
};
