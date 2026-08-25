import { Logger } from "@nestjs/common";
import { createStepContext } from "../../common/workflow/step-context";
import { WorkflowRegistry } from "../../common/workflow";
import {
  isSuspension,
  type JsonValue,
  type RecordedStep,
  type WorkflowStepStore,
} from "../../common/workflow/workflow.types";
import type { CrmImportService } from "./crm-import.service";
import { CrmImportWorkflow } from "./crm-import.workflow";
import { COMMIT_WORKFLOW, REVERT_WORKFLOW } from "./import-workflow-names";
import { ATTEMPT_BUDGET_MS, BATCH_ROWS } from "./import-batches";

const ORG = "org-1";
const IMPORT = "import-1";
const RUN = "run-1";

/**
 * The step store, in memory, obeying the one rule the whole design leans on:
 * **only a COMPLETED step is memoised.** A step whose previous attempt FAILED
 * runs again. A fake that memoised failures too would make every idempotence
 * test here pass for the wrong reason.
 */
class FakeStepStore implements WorkflowStepStore {
  readonly steps = new Map<string, RecordedStep>();

  loadSteps(): Promise<RecordedStep[]> {
    return Promise.resolve([...this.steps.values()]);
  }

  recordStep(step: {
    stepName: string;
    status: "COMPLETED" | "FAILED";
    output: JsonValue | null;
  }): Promise<void> {
    this.steps.set(step.stepName, {
      stepName: step.stepName,
      status: step.status,
      output: step.output,
    });
    return Promise.resolve();
  }

  named(prefix: string): string[] {
    return [...this.steps.keys()].filter((name) => name.startsWith(prefix)).sort();
  }
}

interface Attempt {
  outcome: "completed" | "suspended" | "failed";
  error?: unknown;
  output?: JsonValue | void;
}

/**
 * One attempt at a run, through the REAL step context.
 *
 * Deliberately not a hand-written replay: the memoisation rules are the thing
 * under test, and a fake step context would be a second implementation of them
 * that agrees with the real one only by inspection.
 */
async function attempt(
  workflow: CrmImportWorkflow,
  registry: WorkflowRegistry,
  store: FakeStepStore,
  name: string,
  input: Record<string, unknown>,
  attemptNumber: number,
): Promise<Attempt> {
  void workflow;
  const definition = registry.get(name);
  if (!definition) throw new Error(`${name} is not registered`);

  const step = await createStepContext({
    runId: RUN,
    organizationId: ORG,
    attempt: attemptNumber,
    store,
  });

  try {
    const output = await definition.handler(step, {
      runId: RUN,
      organizationId: ORG,
      attempt: attemptNumber,
      input,
    });
    return { outcome: "completed", output };
  } catch (error) {
    if (isSuspension(error)) return { outcome: "suspended" };
    return { outcome: "failed", error };
  }
}

interface FakeService {
  service: CrmImportService;
  /** The windows `commitBatch` was actually asked to do work for. */
  committed: number[];
  reverted: number[];
  finished: number;
  revertFinished: number;
}

function fakeImports(
  options: {
    maxRowNumber?: number;
    settled?: boolean;
    /** Windows whose FIRST attempt throws, by starting row number. */
    failsAt?: number[];
  } = {},
): FakeService {
  const maxRowNumber = options.maxRowNumber ?? 500;
  const failsAt = new Set(options.failsAt ?? []);
  const state: FakeService = {
    committed: [],
    reverted: [],
    finished: 0,
    revertFinished: 0,
    service: undefined as unknown as CrmImportService,
  };

  state.service = {
    beginCommit: () =>
      Promise.resolve({ settled: options.settled ?? false, total: maxRowNumber, maxRowNumber }),
    beginRevert: () =>
      Promise.resolve({ settled: options.settled ?? false, total: maxRowNumber, maxRowNumber }),

    commitBatch: (_org: string, _id: string, window: { fromRow: number }) => {
      if (failsAt.has(window.fromRow)) {
        // Once. A step whose attempt failed is re-run, and the second time it
        // has to be allowed to succeed or nothing would ever finish.
        failsAt.delete(window.fromRow);
        return Promise.reject(new Error(`window ${String(window.fromRow)} died`));
      }
      state.committed.push(window.fromRow);
      return Promise.resolve({
        created: 1,
        updated: 0,
        merged: 0,
        review: 0,
        skipped: 0,
        failed: 0,
      });
    },

    revertBatch: (_org: string, _id: string, window: { fromRow: number }) => {
      state.reverted.push(window.fromRow);
      return Promise.resolve({ deleted: 1, restored: 0, dismissed: 0, failed: 0 });
    },

    finishCommit: () => {
      state.finished += 1;
      return Promise.resolve();
    },
    finishRevert: () => {
      state.revertFinished += 1;
      return Promise.resolve();
    },
  } as unknown as CrmImportService;

  return state;
}

function build(imports: CrmImportService) {
  const registry = new WorkflowRegistry();
  const workflow = new CrmImportWorkflow(registry, imports);
  workflow.onModuleInit();
  return { registry, workflow, store: new FakeStepStore() };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
});

describe("committing an import durably", () => {
  it("does a step per batch of rows, not one step for the file", () => {
    // The defect the previous version of this file described and declined to
    // fix: one step is one transaction, so a timeout rolls back every
    // `committed_at` it wrote and all five attempts hit the same ceiling.
    const { service } = fakeImports({ maxRowNumber: 500 });
    const { registry, workflow, store } = build(service);

    return attempt(workflow, registry, store, COMMIT_WORKFLOW, { crmImportId: IMPORT }, 1).then(
      (result) => {
        expect(result.outcome).toBe("completed");
        expect(store.named("commit-batch-")).toEqual([
          "commit-batch-0",
          "commit-batch-1",
          "commit-batch-2",
          "commit-batch-3",
          "commit-batch-4",
        ]);
      },
    );
  });

  /**
   * The criterion, stated as a test: a run that dies mid-import resumes without
   * double-writing.
   */
  it("resumes where it died, without redoing a batch that finished", async () => {
    const fake = fakeImports({ maxRowNumber: 500, failsAt: [201] });
    const { registry, workflow, store } = build(fake.service);

    const first = await attempt(
      workflow,
      registry,
      store,
      COMMIT_WORKFLOW,
      { crmImportId: IMPORT },
      1,
    );

    expect(first.outcome).toBe("failed");
    // The two windows before the failure did their work and are memoised; the
    // one that died is recorded as FAILED, which is NOT a memo.
    expect(fake.committed).toEqual([1, 101]);
    expect(store.steps.get("commit-batch-2")?.status).toBe("FAILED");

    const second = await attempt(
      workflow,
      registry,
      store,
      COMMIT_WORKFLOW,
      { crmImportId: IMPORT },
      2,
    );

    expect(second.outcome).toBe("completed");
    // The whole claim: rows 1-200 are not touched a second time.
    expect(fake.committed).toEqual([1, 101, 201, 301, 401]);
    expect(fake.finished).toBe(1);
  });

  it("adds up to the same totals on the attempt that only replays", async () => {
    // A resumed run reaches the finish with the tallies of the work it did not
    // do, because each batch's counts are its memo rather than a recount.
    const fake = fakeImports({ maxRowNumber: 500, failsAt: [401] });
    const { registry, workflow, store } = build(fake.service);

    await attempt(workflow, registry, store, COMMIT_WORKFLOW, { crmImportId: IMPORT }, 1);
    const second = await attempt(
      workflow,
      registry,
      store,
      COMMIT_WORKFLOW,
      { crmImportId: IMPORT },
      2,
    );

    expect(second.output).toMatchObject({ created: 5 });
  });

  it("does nothing at all for a run that arrives after the import is done", async () => {
    // Settled rather than thrown: throwing would burn five attempts and
    // dead-letter a run whose work somebody else finished.
    const fake = fakeImports({ settled: true });
    const { registry, workflow, store } = build(fake.service);

    const result = await attempt(
      workflow,
      registry,
      store,
      COMMIT_WORKFLOW,
      { crmImportId: IMPORT },
      1,
    );

    expect(result.outcome).toBe("completed");
    expect(fake.committed).toEqual([]);
    expect(fake.finished).toBe(0);
  });

  it("refuses to run without knowing which import it is for", async () => {
    const { registry, workflow, store } = build(fakeImports().service);
    const result = await attempt(workflow, registry, store, COMMIT_WORKFLOW, {}, 1);
    expect(result.outcome).toBe("failed");
  });
});

describe("releasing the run when an attempt has done enough", () => {
  /**
   * A long file must not be one long attempt, or it is one long transaction
   * again by another name. The budget is wall-clock, so the clock is what the
   * test moves.
   */
  const spendBudgetAfter = (calls: number) => {
    const start = Date.now();
    let readings = 0;
    return jest.spyOn(Date, "now").mockImplementation(() => {
      readings += 1;
      return readings <= calls ? start : start + ATTEMPT_BUDGET_MS + 1;
    });
  };

  it("suspends part-way through, and picks up at the next window", async () => {
    const fake = fakeImports({ maxRowNumber: 500 });
    const { registry, workflow, store } = build(fake.service);

    // Readings: one for `startedAt`, one for the first window's check.
    const clock = spendBudgetAfter(2);
    try {
      const first = await attempt(
        workflow,
        registry,
        store,
        COMMIT_WORKFLOW,
        { crmImportId: IMPORT },
        1,
      );
      expect(first.outcome).toBe("suspended");
    } finally {
      clock.mockRestore();
    }

    expect(fake.committed).toEqual([1]);
    expect(store.steps.get("commit-pause-after-1")?.status).toBe("COMPLETED");
    expect(fake.finished).toBe(0);

    const second = await attempt(
      workflow,
      registry,
      store,
      COMMIT_WORKFLOW,
      { crmImportId: IMPORT },
      1,
    );

    expect(second.outcome).toBe("completed");
    // Window 0 is memoised and window 1's pause has elapsed, so the resumed run
    // walks straight past both rather than sleeping the same pause again.
    expect(fake.committed).toEqual([1, 101, 201, 301, 401]);
    expect(fake.finished).toBe(1);
  });

  it("charges a resumed attempt nothing for the batches it only replays", async () => {
    // The budget starts when the attempt starts, and replaying a memo is a
    // SELECT. If replay were charged, a long import would suspend earlier and
    // earlier and eventually never reach its own frontier.
    const fake = fakeImports({ maxRowNumber: 5 * BATCH_ROWS });
    const { registry, workflow, store } = build(fake.service);

    await attempt(workflow, registry, store, COMMIT_WORKFLOW, { crmImportId: IMPORT }, 1);
    expect(fake.committed).toHaveLength(5);
  });
});

describe("taking it back", () => {
  it("walks the file backwards, so a party is not deleted before its update is undone", async () => {
    const fake = fakeImports({ maxRowNumber: 500 });
    const { registry, workflow, store } = build(fake.service);

    const result = await attempt(
      workflow,
      registry,
      store,
      REVERT_WORKFLOW,
      { crmImportId: IMPORT, userId: "user-1" },
      1,
    );

    expect(result.outcome).toBe("completed");
    expect(fake.reverted).toEqual([401, 301, 201, 101, 1]);
    expect(fake.revertFinished).toBe(1);
  });

  it("keeps its memos apart from the commit's", async () => {
    // Two runs walk the same file. A shared step name would let the undo read
    // the commit's memo and skip windows it never touched.
    const fake = fakeImports({ maxRowNumber: 200 });
    const { registry, workflow, store } = build(fake.service);

    await attempt(workflow, registry, store, REVERT_WORKFLOW, { crmImportId: IMPORT }, 1);

    expect(store.named("revert-batch-")).toEqual(["revert-batch-0", "revert-batch-1"]);
    expect(store.named("commit-batch-")).toEqual([]);
  });
});
