import { executeRun, type RunLifecycleStore, type RunRecord } from "./workflow-runner";
import { WorkflowRegistry } from "./workflow-registry";
import type { JsonValue, RecordedStep, StepContext, WorkflowStepStore } from "./workflow.types";

function stepStore(initial: RecordedStep[] = []): WorkflowStepStore & { rows: RecordedStep[] } {
  const rows = [...initial];
  return {
    rows,
    loadSteps: async () => rows,
    recordStep: async (step) => {
      const index = rows.findIndex((row) => row.stepName === step.stepName);
      const row: RecordedStep = {
        stepName: step.stepName,
        status: step.status,
        output: step.output,
      };
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    },
  };
}

function lifecycleSpy(): RunLifecycleStore & { calls: string[]; detail: unknown[] } {
  const calls: string[] = [];
  const detail: unknown[] = [];
  return {
    calls,
    detail,
    complete: async (runId, output) => {
      calls.push("complete");
      detail.push({ runId, output });
    },
    suspend: async (runId, wakeAt) => {
      calls.push("suspend");
      detail.push({ runId, wakeAt });
    },
    retry: async (runId, attempt, runAfter, error) => {
      calls.push("retry");
      detail.push({ runId, attempt, runAfter, error });
    },
    deadLetter: async (runId, attempt, error) => {
      calls.push("deadLetter");
      detail.push({ runId, attempt, error });
    },
  };
}

const run: RunRecord = {
  workflowRunId: "run-1",
  organizationId: "org-1",
  workflowName: "onboard",
  input: { partyId: "p-1" },
  attempt: 0,
  maxAttempts: 3,
};

const now = () => new Date("2026-08-23T10:00:00.000Z");

describe("executeRun", () => {
  it("runs the workflow and records completion", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", handler: async () => ({ ok: true }) });
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(outcome).toBe("completed");
    expect(lifecycle.calls).toEqual(["complete"]);
    expect(lifecycle.detail[0]).toMatchObject({ output: { ok: true } });
  });

  it("hands the workflow its input and identity", async () => {
    const registry = new WorkflowRegistry();
    let seen: unknown;
    registry.register({
      name: "onboard",
      handler: async (_step, context) => {
        seen = context;
        return null;
      },
    });

    await executeRun({ run, registry, steps: stepStore(), lifecycle: lifecycleSpy(), now });

    expect(seen).toMatchObject({
      runId: "run-1",
      organizationId: "org-1",
      attempt: 1,
      input: { partyId: "p-1" },
    });
  });

  it("resumes past completed steps without repeating their work", async () => {
    const registry = new WorkflowRegistry();
    const executed: string[] = [];
    registry.register({
      name: "onboard",
      handler: async (step: StepContext) => {
        await step.run("charge", async () => {
          executed.push("charge");
          return 1;
        });
        await step.run("notify", async () => {
          executed.push("notify");
          return 2;
        });
        return null;
      },
    });

    const steps = stepStore([{ stepName: "charge", status: "COMPLETED", output: 1 }]);
    await executeRun({
      run: { ...run, attempt: 1 },
      registry,
      steps,
      lifecycle: lifecycleSpy(),
      now,
    });

    // The charge is not taken twice, which is the entire point of durability.
    expect(executed).toEqual(["notify"]);
  });

  it("suspends rather than failing when a step sleeps", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.sleep("wait", 60_000);
        return null;
      },
    });
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(outcome).toBe("suspended");
    expect(lifecycle.calls).toEqual(["suspend"]);
    expect(lifecycle.detail[0]).toMatchObject({
      wakeAt: new Date("2026-08-23T10:01:00.000Z"),
    });
  });

  it("continues past an elapsed sleep on the next attempt", async () => {
    const registry = new WorkflowRegistry();
    const executed: string[] = [];
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.sleep("wait", 60_000);
        await step.run("after", async () => {
          executed.push("after");
          return 1;
        });
        return null;
      },
    });

    const steps = stepStore([
      { stepName: "wait", status: "COMPLETED", output: { wakeAt: "2026-08-23T10:01:00.000Z" } },
    ]);
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({
      run: { ...run, attempt: 1 },
      registry,
      steps,
      lifecycle,
      now,
    });

    expect(executed).toEqual(["after"]);
    expect(outcome).toBe("completed");
  });

  it("schedules a retry with backoff when a step throws", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.run("charge", async () => {
          throw new Error("provider down");
        });
        return null;
      },
    });
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(outcome).toBe("retry");
    expect(lifecycle.detail[0]).toMatchObject({ attempt: 1 });
    const { runAfter } = lifecycle.detail[0] as { runAfter: Date };
    expect(runAfter.getTime()).toBeGreaterThan(now().getTime());
  });

  it("dead-letters visibly once attempts are exhausted, rather than retrying forever", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async () => {
        throw new Error("still broken");
      },
    });
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({
      run: { ...run, attempt: 2, maxAttempts: 3 },
      registry,
      steps: stepStore(),
      lifecycle,
      now,
    });

    expect(outcome).toBe("dead-lettered");
    expect(lifecycle.detail[0]).toMatchObject({ attempt: 3 });
    expect(String((lifecycle.detail[0] as { error: string }).error)).toContain("still broken");
  });

  it("records the failure detail, so a dead letter says why", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async () => {
        throw new Error("card declined");
      },
    });
    const lifecycle = lifecycleSpy();

    await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(String((lifecycle.detail[0] as { error: string }).error)).toContain("card declined");
  });

  it("keeps the failed step on record for inspection", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.run("charge", async () => {
          throw new Error("boom");
        });
        return null;
      },
    });
    const steps = stepStore();

    await executeRun({ run, registry, steps, lifecycle: lifecycleSpy(), now });

    expect(steps.rows).toEqual([{ stepName: "charge", status: "FAILED", output: null }]);
  });

  it("dead-letters an unregistered workflow immediately instead of retrying", async () => {
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({
      run,
      registry: new WorkflowRegistry(),
      steps: stepStore(),
      lifecycle,
      now,
    });

    expect(outcome).toBe("dead-lettered");
    expect(String((lifecycle.detail[0] as { error: string }).error)).toContain("not registered");
  });

  it("lets a definition override the attempt limit", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      maxAttempts: 1,
      handler: async () => {
        throw new Error("no retries for this one");
      },
    });
    const lifecycle = lifecycleSpy();

    const outcome = await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(outcome).toBe("dead-lettered");
  });

  it("wraps each step in the boundary the runner supplies", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.run("a", async () => 1);
        await step.run("b", async () => 2);
        return null;
      },
    });
    const wrapped: string[] = [];

    await executeRun({
      run,
      registry,
      steps: stepStore(),
      lifecycle: lifecycleSpy(),
      now,
      withinStep: async (name, fn) => {
        wrapped.push(name);
        return fn();
      },
    });

    // The service passes a tenant transaction here, so every step's queries
    // carry the organisation and commit with their own memo.
    expect(wrapped).toEqual(["a", "b"]);
  });

  it("reports the failure to the caller's error sink as well as recording it", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async () => {
        throw new Error("observe me");
      },
    });
    const onError = jest.fn();

    await executeRun({
      run,
      registry,
      steps: stepStore(),
      lifecycle: lifecycleSpy(),
      now,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not report a suspension as an error", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        await step.sleep("wait", 1000);
        return null;
      },
    });
    const onError = jest.fn();

    await executeRun({
      run,
      registry,
      steps: stepStore(),
      lifecycle: lifecycleSpy(),
      now,
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("WorkflowRegistry", () => {
  it("refuses two handlers under one name", () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "onboard", handler: async () => null });

    expect(() => registry.register({ name: "onboard", handler: async () => null })).toThrow(
      /already registered/,
    );
  });

  it("finds the workflows an event starts", () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "a", triggers: ["party.created"], handler: async () => null });
    registry.register({ name: "b", triggers: ["deal.won"], handler: async () => null });

    expect(registry.triggeredBy("party.created").map((d) => d.name)).toEqual(["a"]);
  });

  it("returns nothing for an event no workflow listens to", () => {
    expect(new WorkflowRegistry().triggeredBy("nobody.cares")).toEqual([]);
  });
});

describe("a workflow's return value", () => {
  it("is recorded, so a caller can read what the run produced", async () => {
    const registry = new WorkflowRegistry();
    registry.register({
      name: "onboard",
      handler: async (step) => {
        const id = await step.run("create", async () => "party-9");
        return { created: id } as JsonValue;
      },
    });
    const lifecycle = lifecycleSpy();

    await executeRun({ run, registry, steps: stepStore(), lifecycle, now });

    expect(lifecycle.detail[0]).toMatchObject({ output: { created: "party-9" } });
  });
});
