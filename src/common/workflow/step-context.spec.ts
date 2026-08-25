import { createStepContext } from "./step-context";
import {
  isSuspension,
  type JsonValue,
  type RecordedStep,
  type WorkflowStepStore,
} from "./workflow.types";

function memoryStore(initial: RecordedStep[] = []): WorkflowStepStore & {
  readonly rows: RecordedStep[];
  readonly writes: string[];
} {
  const rows = [...initial];
  const writes: string[] = [];

  return {
    rows,
    writes,
    loadSteps: async () => rows,
    recordStep: async (step) => {
      writes.push(step.stepName);
      const existing = rows.findIndex((row) => row.stepName === step.stepName);
      const row: RecordedStep = {
        stepName: step.stepName,
        status: step.status,
        output: step.output,
      };
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
    },
  };
}

const base = { runId: "run-1", organizationId: "org-1", attempt: 0 };

describe("createStepContext", () => {
  it("runs a step and records its output", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });

    await expect(step.run("charge", async () => ({ id: "ch_1" }))).resolves.toEqual({
      id: "ch_1",
    });
    expect(store.rows).toEqual([
      { stepName: "charge", status: "COMPLETED", output: { id: "ch_1" } },
    ]);
  });

  it("returns a recorded result without running the work again", async () => {
    // This is the whole resume mechanism: a resumed run must not re-charge a card.
    const store = memoryStore([
      { stepName: "charge", status: "COMPLETED", output: { id: "ch_1" } },
    ]);
    const step = await createStepContext({ ...base, attempt: 1, store });

    const work = jest.fn();
    await expect(step.run("charge", work as () => Promise<JsonValue>)).resolves.toEqual({
      id: "ch_1",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("executes only the steps past the recorded frontier", async () => {
    const store = memoryStore([
      { stepName: "first", status: "COMPLETED", output: 1 },
      { stepName: "second", status: "COMPLETED", output: 2 },
    ]);
    const step = await createStepContext({ ...base, attempt: 1, store });
    const ran: string[] = [];

    await step.run("first", async () => {
      ran.push("first");
      return 1;
    });
    await step.run("second", async () => {
      ran.push("second");
      return 2;
    });
    await step.run("third", async () => {
      ran.push("third");
      return 3;
    });

    expect(ran).toEqual(["third"]);
  });

  it("records a null output for a step that returns nothing", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });

    await step.run("notify", async () => undefined);

    expect(store.rows[0]).toMatchObject({ stepName: "notify", output: null });
  });

  it("records a failure and rethrows, so the runner can decide about retrying", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });

    await expect(
      step.run("charge", async () => {
        throw new Error("card declined");
      }),
    ).rejects.toThrow("card declined");

    expect(store.rows[0]).toMatchObject({ stepName: "charge", status: "FAILED" });
  });

  it("retries a step that failed on a previous attempt", async () => {
    // The failure was recorded for inspection, not as a permanent verdict.
    const store = memoryStore([{ stepName: "charge", status: "FAILED", output: null }]);
    const step = await createStepContext({ ...base, attempt: 1, store });

    await expect(step.run("charge", async () => "ok")).resolves.toBe("ok");
  });

  it("refuses a duplicate step name, which would silently share one memo", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });

    await step.run("charge", async () => 1);
    await expect(step.run("charge", async () => 2)).rejects.toThrow(/used twice/);
  });

  it("refuses an empty step name", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });
    await expect(step.run("", async () => 1)).rejects.toThrow(/non-empty/);
  });

  it("suspends on a sleep, carrying the time to wake", async () => {
    const store = memoryStore();
    const clock = new Date("2026-08-23T10:00:00.000Z");
    const step = await createStepContext({ ...base, store, now: () => clock });

    const error = await step.sleep("wait", 60_000).catch((caught: unknown) => caught);

    expect(isSuspension(error)).toBe(true);
    if (!isSuspension(error)) return;
    expect(error.wakeAt.toISOString()).toBe("2026-08-23T10:01:00.000Z");
  });

  it("records the sleep, so a resumed run walks past it instead of waiting again", async () => {
    const store = memoryStore([
      { stepName: "wait", status: "COMPLETED", output: { wakeAt: "2026-08-23T10:01:00.000Z" } },
    ]);
    const step = await createStepContext({ ...base, attempt: 1, store });

    await expect(step.sleep("wait", 60_000)).resolves.toBeUndefined();
  });

  it("treats a non-positive sleep as an immediate wake rather than a past one", async () => {
    const store = memoryStore();
    const clock = new Date("2026-08-23T10:00:00.000Z");
    const step = await createStepContext({ ...base, store, now: () => clock });

    const error = await step.sleep("wait", -5).catch((caught: unknown) => caught);

    expect(isSuspension(error) && error.wakeAt.getTime()).toBe(clock.getTime());
  });

  it("exposes the run identity a step may need", async () => {
    const step = await createStepContext({ ...base, attempt: 3, store: memoryStore() });
    expect(step).toMatchObject({ runId: "run-1", organizationId: "org-1", attempt: 3 });
  });

  it("writes each step exactly once per attempt", async () => {
    const store = memoryStore();
    const step = await createStepContext({ ...base, store });

    await step.run("a", async () => 1);
    await step.run("b", async () => 2);

    expect(store.writes).toEqual(["a", "b"]);
  });
});
