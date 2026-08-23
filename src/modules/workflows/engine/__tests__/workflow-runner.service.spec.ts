jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (
    _db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(currentTx),
}));

jest.mock("../../../../common/tenant/for-each-org", () => ({
  forEachOrg: (
    _db: unknown,
    _sweep: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => fn(currentTx, "org-1"),
}));

import { WorkflowRunnerService, MAX_STEPS_PER_EXECUTION } from "../workflow-runner.service";
import type { Db } from "../../../../db/drizzle.module";

interface StepRow {
  nodeId: string;
  nodeType: string;
  status: string;
  error: string | null;
}

interface Recorder {
  steps: StepRow[];
  updates: Record<string, unknown>[];
  selects: unknown[][];
}

let currentTx: unknown;

function thenableWith<T>(value: T) {
  return Object.assign(Promise.resolve(undefined), {
    returning: () => Promise.resolve(value),
  });
}

function makeTx(rec: Recorder) {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        rec.updates.push(values);
        return { where: () => thenableWith(claimRows) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rec.selects.shift() ?? []) }),
      }),
    }),
    insert: () => ({
      values: (row: StepRow) => {
        rec.steps.push(row);
        return Promise.resolve(undefined);
      },
    }),
  };
}

let claimRows: unknown[] = [];

function node(id: string, nodeType: string, configuration: Record<string, unknown> = {}) {
  return { id, data: { nodeType, configuration } };
}

function setup(definition: unknown, opts?: { claimed?: boolean; context?: unknown }) {
  const rec: Recorder = { steps: [], updates: [], selects: [] };
  const execution = {
    id: "exec-1",
    orgId: "org-1",
    workflowVersionId: "ver-1",
    triggerData: { priority: "HIGH" },
    context: opts?.context ?? null,
  };

  claimRows = opts?.claimed === false ? [] : [execution];
  rec.selects.push([{ id: "exec-1", status: "pending", context: execution.context }]);
  rec.selects.push([{ definitionJson: definition }]);

  currentTx = makeTx(rec);
  const service = new WorkflowRunnerService({} as Db);
  return { service, rec };
}

function statusUpdates(rec: Recorder): string[] {
  return rec.updates
    .map((u) => u["status"])
    .filter((s): s is string => typeof s === "string");
}

describe("WorkflowRunnerService.sweep", () => {
  it("runs a trigger -> end workflow to completion", async () => {
    const { service, rec } = setup({
      nodes: [node("t", "trigger"), node("e", "end")],
      edges: [{ source: "t", target: "e" }],
    });

    const result = await service.sweep();

    expect(result.claimed).toBe(1);
    expect(result.completed).toBe(1);
    expect(rec.steps.map((s) => s.nodeId)).toEqual(["t", "e"]);
    expect(statusUpdates(rec)).toContain("completed");
  });

  it("takes the false branch when the condition does not match", async () => {
    const { service, rec } = setup({
      nodes: [
        node("t", "trigger"),
        node("c", "condition", {
          conditions: [{ field: "priority", op: "eq", value: "LOW" }],
        }),
        node("yes", "end"),
        node("no", "end"),
      ],
      edges: [
        { source: "t", target: "c" },
        { source: "c", target: "yes", sourceHandle: "true" },
        { source: "c", target: "no", sourceHandle: "false" },
      ],
    });

    await service.sweep();

    expect(rec.steps.map((s) => s.nodeId)).toEqual(["t", "c", "no"]);
  });

  it("fails the execution on a node type with no executor instead of leaving it pending", async () => {
    const { service, rec } = setup({
      nodes: [node("t", "trigger"), node("s", "script")],
      edges: [{ source: "t", target: "s" }],
    });

    const result = await service.sweep();

    expect(result.failed).toBe(1);
    expect(statusUpdates(rec)).toContain("failed");
    const failedStep = rec.steps.find((s) => s.status === "failed");
    expect(failedStep?.nodeType).toBe("script");
    expect(failedStep?.error).toContain("script");
  });

  it("suspends on a delay node and records where to resume", async () => {
    const { service, rec } = setup({
      nodes: [node("t", "trigger"), node("d", "delay", { minutes: 10 }), node("e", "end")],
      edges: [
        { source: "t", target: "d" },
        { source: "d", target: "e" },
      ],
    });

    const result = await service.sweep();

    expect(result.suspended).toBe(1);
    const waiting = rec.updates.find((u) => u["status"] === "waiting");
    expect(waiting).toBeDefined();
    const context = waiting?.["context"];
    expect(context).toMatchObject({ cursor: "e" });
    expect(statusUpdates(rec)).not.toContain("completed");
  });

  it("fails a definition the parser rejects rather than crashing the sweep", async () => {
    const { service, rec } = setup({ nodes: [], edges: [] });

    const result = await service.sweep();

    expect(result.failed).toBe(1);
    expect(rec.steps[0]?.error).toContain("Invalid workflow definition");
  });

  it("stops a cyclic definition at the step ceiling", async () => {
    const { service, rec } = setup({
      nodes: [node("t", "trigger"), node("a", "condition", {
        conditions: [{ field: "priority", op: "exists" }],
      })],
      edges: [
        { source: "t", target: "a" },
        { source: "a", target: "a" },
      ],
    });

    const result = await service.sweep();

    expect(result.failed).toBe(1);
    expect(rec.steps.length).toBeLessThanOrEqual(MAX_STEPS_PER_EXECUTION + 1);
    expect(rec.steps.at(-1)?.error).toContain("cycle");
  });

  it("skips an execution another sweep already claimed", async () => {
    const { service, rec } = setup(
      { nodes: [node("t", "trigger")], edges: [] },
      { claimed: false },
    );

    const result = await service.sweep();

    expect(result.claimed).toBe(0);
    expect(rec.steps).toEqual([]);
  });

  it("resumes from the stored cursor instead of restarting at the trigger", async () => {
    const { service, rec } = setup(
      {
        nodes: [node("t", "trigger"), node("d", "delay", { minutes: 1 }), node("e", "end")],
        edges: [
          { source: "t", target: "d" },
          { source: "d", target: "e" },
        ],
      },
      { context: { cursor: "e", resumeAt: "2020-01-01T00:00:00.000Z", variables: {}, steps: 2 } },
    );

    const result = await service.sweep();

    expect(result.completed).toBe(1);
    expect(rec.steps.map((s) => s.nodeId)).toEqual(["e"]);
  });
});
