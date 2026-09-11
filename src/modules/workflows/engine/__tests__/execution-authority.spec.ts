jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (
    _db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(currentTx),
}));

import { advanceExecution } from "../execution-advance";
import type { NodeDispatchPort } from "../node-outcome";
import type { ClaimedExecution } from "../execution-claim";

let currentTx: unknown;

interface StepRow {
  nodeId: string;
  nodeType: string;
  status: string;
  error: string | null;
}

interface Recorder {
  steps: StepRow[];
  updates: Record<string, unknown>[];
  selectQueue: unknown[][];
  executionStatus: Array<{ executionStatus: string }>;
}

function makeTx(rec: Recorder) {
  return {
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () =>
            projection !== undefined && "executionStatus" in projection
              ? Promise.resolve(rec.executionStatus)
              : Promise.resolve(rec.selectQueue.shift() ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        rec.updates.push(values);
        return { where: () => ({ returning: () => Promise.resolve([]) }) };
      },
    }),
    insert: () => ({
      values: (row: StepRow) => {
        rec.steps.push(row);
        return Promise.resolve(undefined);
      },
    }),
  };
}

const SIMPLE_GRAPH = {
  nodes: [
    { id: "t", data: { nodeType: "trigger", configuration: {} } },
    { id: "e", data: { nodeType: "end", configuration: {} } },
  ],
  edges: [{ source: "t", target: "e" }],
};

function makeExecution(
  overrides: Partial<ClaimedExecution> = {},
): ClaimedExecution {
  return {
    id: "exec-1",
    orgId: "org-1",
    workflowVersionId: "ver-1",
    triggerData: {},
    context: null,
    triggeredBy: null,
    ...overrides,
  };
}

const passDispatcher: NodeDispatchPort = {
  execute: jest.fn().mockResolvedValue({ kind: "continue", output: {} }),
};

describe("advanceExecution — actor authority gate", () => {
  it("proof — neutering the membership check (mock returns ACTIVE) lets execution complete", async () => {
    const rec: Recorder = {
      steps: [],
      updates: [],
      executionStatus: [{ executionStatus: "running" }],
      selectQueue: [
        [{ status: "ACTIVE" }],
        [{ definitionJson: SIMPLE_GRAPH }],
      ],
    };
    currentTx = makeTx(rec);

    const outcome = await advanceExecution(
      currentTx as never,
      makeExecution({ triggeredBy: "some-user" }),
      passDispatcher,
      null,
    );

    expect(outcome).toBe("completed");
  });

  it("fails an execution whose triggeredBy user has no membership row (not found)", async () => {
    const rec: Recorder = {
      steps: [],
      updates: [],
      executionStatus: [{ executionStatus: "running" }],
      selectQueue: [],
    };
    currentTx = makeTx(rec);

    const outcome = await advanceExecution(
      currentTx as never,
      makeExecution({ triggeredBy: "revoked-user" }),
      passDispatcher,
      null,
    );

    expect(outcome).toBe("failed");
    const failStep = rec.steps.find((s) => s.status === "failed");
    expect(failStep).toBeDefined();
    expect(failStep?.error).toMatch(/no longer an active member/i);
    expect(failStep?.nodeId).toBe("authority-check");
    const statusUpdates = rec.updates.map((u) => u["status"]);
    expect(statusUpdates).toContain("failed");
  });

  it("fails when the triggeredBy user is SUSPENDED", async () => {
    const rec: Recorder = {
      steps: [],
      updates: [],
      executionStatus: [{ executionStatus: "running" }],
      selectQueue: [[{ status: "SUSPENDED" }]],
    };
    currentTx = makeTx(rec);

    const outcome = await advanceExecution(
      currentTx as never,
      makeExecution({ triggeredBy: "suspended-user" }),
      passDispatcher,
      null,
    );

    expect(outcome).toBe("failed");
    const failStep = rec.steps.find((s) => s.status === "failed");
    expect(failStep?.error).toMatch(/no longer an active member/i);
  });

  it("fails when the triggeredBy user has LEFT the organisation", async () => {
    const rec: Recorder = {
      steps: [],
      updates: [],
      executionStatus: [{ executionStatus: "running" }],
      selectQueue: [[{ status: "LEFT" }]],
    };
    currentTx = makeTx(rec);

    const outcome = await advanceExecution(
      currentTx as never,
      makeExecution({ triggeredBy: "departed-user" }),
      passDispatcher,
      null,
    );

    expect(outcome).toBe("failed");
  });

  it("skips the membership check when triggeredBy is null (scheduled / system execution)", async () => {
    const rec: Recorder = {
      steps: [],
      updates: [],
      executionStatus: [{ executionStatus: "running" }],
      selectQueue: [[{ definitionJson: SIMPLE_GRAPH }]],
    };
    currentTx = makeTx(rec);

    const outcome = await advanceExecution(
      currentTx as never,
      makeExecution({ triggeredBy: null }),
      passDispatcher,
      null,
    );

    expect(outcome).toBe("completed");
  });
});
