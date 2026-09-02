import { advanceExecution } from "../execution-advance";
import type { NodeDispatchPort } from "../node-outcome";
import type { ClaimedExecution } from "../execution-claim";

interface Recorder {
  steps: Array<{ nodeId: string }>;
  updates: Record<string, unknown>[];
  statusReads: number;
}

const THREE_STEP_GRAPH = {
  nodes: [
    { id: "t", data: { nodeType: "trigger", configuration: {} } },
    { id: "a", data: { nodeType: "end", configuration: {} } },
    { id: "b", data: { nodeType: "end", configuration: {} } },
  ],
  edges: [
    { source: "t", target: "a" },
    { source: "a", target: "b" },
  ],
};

function makeTx(rec: Recorder, statuses: string[]) {
  return {
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (projection !== undefined && "executionStatus" in projection) {
              const next = statuses[rec.statusReads] ?? "running";
              rec.statusReads += 1;
              return Promise.resolve([{ executionStatus: next }]);
            }
            return Promise.resolve([{ definitionJson: THREE_STEP_GRAPH }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        rec.updates.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    insert: () => ({
      values: (row: { nodeId: string }) => {
        rec.steps.push(row);
        return Promise.resolve(undefined);
      },
    }),
  };
}

const execution: ClaimedExecution = {
  id: "exec-1",
  orgId: "org-1",
  workflowVersionId: "ver-1",
  triggerData: {},
  context: null,
  triggeredBy: null,
} as ClaimedExecution;

const dispatcher: NodeDispatchPort = {
  execute: jest.fn().mockResolvedValue({ kind: "continue", output: {} }),
};

function makeRecorder(): Recorder {
  return { steps: [], updates: [], statusReads: 0 };
}

beforeEach(() => {
  (dispatcher.execute as jest.Mock).mockClear();
});

describe("advanceExecution — cooperative cancellation", () => {
  it("stops the walk at the next step boundary once the run is cancelled", async () => {
    const rec = makeRecorder();
    const tx = makeTx(rec, ["running", "cancelled"]);

    const outcome = await advanceExecution(tx as never, execution, dispatcher, null);

    expect(outcome).toBe("suspended");
    expect(rec.steps).toHaveLength(1);
    expect(dispatcher.execute as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a single node when the run is already cancelled", async () => {
    const rec = makeRecorder();
    const tx = makeTx(rec, ["cancelled"]);

    const outcome = await advanceExecution(tx as never, execution, dispatcher, null);

    expect(outcome).toBe("suspended");
    expect(dispatcher.execute as jest.Mock).not.toHaveBeenCalled();
    expect(rec.steps).toHaveLength(0);
  });

  it("records the cursor it stopped at so the run is not silently reset", async () => {
    const rec = makeRecorder();
    const tx = makeTx(rec, ["running", "cancelled"]);

    await advanceExecution(tx as never, execution, dispatcher, null);

    const contextWrite = rec.updates.find((u) => "context" in u && !("status" in u));
    expect(contextWrite).toBeDefined();
    expect(JSON.stringify(contextWrite)).toContain("\"cursor\":\"a\"");
  });

  it("runs to completion while the status stays running (control)", async () => {
    const rec = makeRecorder();
    const tx = makeTx(rec, ["running", "running", "running"]);

    const outcome = await advanceExecution(tx as never, execution, dispatcher, null);

    expect(outcome).toBe("completed");
    expect(dispatcher.execute as jest.Mock).toHaveBeenCalledTimes(3);
  });

  it("never overwrites a cancelled row with a terminal status", async () => {
    const rec = makeRecorder();
    const tx = makeTx(rec, ["running", "cancelled"]);

    await advanceExecution(tx as never, execution, dispatcher, null);

    const terminalWrite = rec.updates.find(
      (u) => u["status"] === "completed" || u["status"] === "failed",
    );
    expect(terminalWrite).toBeUndefined();
  });
});
