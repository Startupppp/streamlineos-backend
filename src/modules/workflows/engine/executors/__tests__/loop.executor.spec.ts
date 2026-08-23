import {
  WorkflowLoopExecutor,
  LOOP_HARD_MAX_ITERATIONS,
} from "../loop.executor";
import type { WorkflowGraphNode } from "../../workflow-graph";
import type { NodeExecutionContext, NodeExecutionInput } from "../../node-outcome";

const NOW = new Date("2026-08-23T10:00:00.000Z");
const CTX: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: null,
};

function loopNode(
  id: string,
  config: Record<string, unknown> = {},
): WorkflowGraphNode {
  return { id, data: { nodeType: "loop", configuration: config } };
}

function makeInput(
  triggerData: Record<string, unknown> = {},
  variables: Record<string, unknown> = {},
): NodeExecutionInput {
  return { triggerData, variables };
}

async function drainLoop(
  executor: WorkflowLoopExecutor,
  node: WorkflowGraphNode,
  inp: NodeExecutionInput,
): Promise<{ collectedItems: unknown[]; iterations: number; stoppedEarly: boolean }> {
  const collectedItems: unknown[] = [];
  const itemVar = (node.data.configuration?.["itemVariable"] as string | undefined) ?? "item";

  while (true) {
    const outcome = await executor.execute(node, inp, NOW, CTX);
    if (outcome.kind !== "continue") throw new Error(`unexpected kind: ${outcome.kind}`);

    if (outcome.branch === "done")
      return {
        collectedItems,
        iterations: outcome.output["iterations"] as number,
        stoppedEarly: outcome.output["stoppedEarly"] as boolean,
      };

    collectedItems.push(inp.variables[itemVar]);
  }
}

describe("WorkflowLoopExecutor", () => {
  let executor: WorkflowLoopExecutor;

  beforeEach(() => {
    executor = new WorkflowLoopExecutor();
  });

  describe("3-item array iterates to completion", () => {
    it("visits each item in order and reports done after the last", async () => {
      const node = loopNode("n1", { itemsPath: "items", itemVariable: "item" });
      const inp = makeInput({ items: ["a", "b", "c"] });

      const result = await drainLoop(executor, node, inp);

      expect(result.collectedItems).toEqual(["a", "b", "c"]);
      expect(result.iterations).toBe(3);
      expect(result.stoppedEarly).toBe(false);
    });

    it("exposes indexVariable when configured", async () => {
      const node = loopNode("n2", {
        itemsPath: "rows",
        itemVariable: "row",
        indexVariable: "rowIndex",
      });
      const inp = makeInput({ rows: ["x", "y", "z"] });
      const indexes: unknown[] = [];

      let outcome = await executor.execute(node, inp, NOW, CTX);
      while (outcome.kind === "continue" && outcome.branch === "loop") {
        indexes.push(inp.variables["rowIndex"]);
        outcome = await executor.execute(node, inp, NOW, CTX);
      }

      expect(indexes).toEqual([0, 1, 2]);
    });
  });

  describe("empty array", () => {
    it("goes directly to done with zero iterations on the first call", async () => {
      const node = loopNode("empty", { itemsPath: "list" });
      const inp = makeInput({ list: [] });

      const outcome = await executor.execute(node, inp, NOW, CTX);

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.branch).toBe("done");
      expect(outcome.output["iterations"]).toBe(0);
      expect(outcome.output["stoppedEarly"]).toBe(false);
    });

    it("does not write loop state to variables for an empty array", async () => {
      const node = loopNode("empty2", { itemsPath: "list" });
      const inp = makeInput({ list: [] });

      await executor.execute(node, inp, NOW, CTX);

      expect(inp.variables["__loop_empty2"]).toBeUndefined();
    });
  });

  describe("non-array path", () => {
    it("fails when the path resolves to a string", async () => {
      const node = loopNode("na1", { itemsPath: "value" });
      const inp = makeInput({ value: "not-an-array" });

      const outcome = await executor.execute(node, inp, NOW, CTX);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toContain("value");
      expect(outcome.error).toContain("string");
    });

    it("fails when the path resolves to a number", async () => {
      const node = loopNode("na2", { itemsPath: "count" });
      const outcome = await executor.execute(node, makeInput({ count: 42 }), NOW, CTX);
      expect(outcome.kind).toBe("failed");
    });

    it("fails when the path resolves to null", async () => {
      const node = loopNode("na3", { itemsPath: "field" });
      const outcome = await executor.execute(node, makeInput({ field: null }), NOW, CTX);
      expect(outcome.kind).toBe("failed");
    });
  });

  describe("missing path", () => {
    it("fails with a descriptive message when itemsPath is absent from the payload", async () => {
      const node = loopNode("mp1", { itemsPath: "no.such.path" });
      const outcome = await executor.execute(node, makeInput({}), NOW, CTX);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toContain("no.such.path");
    });

    it("fails for a nested path whose parent is not an object", async () => {
      const node = loopNode("mp2", { itemsPath: "order.items" });
      const outcome = await executor.execute(node, makeInput({ order: "plain-string" }), NOW, CTX);
      expect(outcome.kind).toBe("failed");
    });
  });

  describe("maxIterations stopping early", () => {
    it("stops after maxIterations and sets stoppedEarly:true", async () => {
      const node = loopNode("mi1", { itemsPath: "things", maxIterations: 2 });
      const inp = makeInput({ things: ["a", "b", "c", "d"] });

      const result = await drainLoop(executor, node, inp);

      expect(result.iterations).toBe(2);
      expect(result.stoppedEarly).toBe(true);
      expect(result.collectedItems).toEqual(["a", "b"]);
    });

    it("completes normally when the array ends before maxIterations", async () => {
      const node = loopNode("mi2", { itemsPath: "short", maxIterations: 10 });
      const inp = makeInput({ short: ["x", "y"] });

      const result = await drainLoop(executor, node, inp);

      expect(result.iterations).toBe(2);
      expect(result.stoppedEarly).toBe(false);
    });
  });

  describe("hard ceiling", () => {
    it("caps iteration at LOOP_HARD_MAX_ITERATIONS regardless of array length", async () => {
      const bigArray = Array.from({ length: LOOP_HARD_MAX_ITERATIONS + 1 }, (_, i) => i);
      const node = loopNode("hc1", { itemsPath: "big" });
      const inp = makeInput({ big: bigArray });

      const result = await drainLoop(executor, node, inp);

      expect(result.iterations).toBe(LOOP_HARD_MAX_ITERATIONS);
      expect(result.stoppedEarly).toBe(true);
    });

    it("caps a maxIterations that exceeds the hard ceiling", async () => {
      const bigArray = Array.from({ length: LOOP_HARD_MAX_ITERATIONS + 10 }, (_, i) => i);
      const node = loopNode("hc2", {
        itemsPath: "big",
        maxIterations: LOOP_HARD_MAX_ITERATIONS + 500,
      });
      const inp = makeInput({ big: bigArray });

      const result = await drainLoop(executor, node, inp);

      expect(result.iterations).toBe(LOOP_HARD_MAX_ITERATIONS);
      expect(result.stoppedEarly).toBe(true);
    });
  });

  describe("two independent loop nodes in one workflow", () => {
    it("maintains separate state for each node under the shared variables object", async () => {
      const nodeA = loopNode("loopA", { itemsPath: "aList", itemVariable: "aItem" });
      const nodeB = loopNode("loopB", { itemsPath: "bList", itemVariable: "bItem" });
      const sharedVariables: Record<string, unknown> = {
        aList: [1, 2],
        bList: ["x", "y", "z"],
      };
      const inpA: NodeExecutionInput = { triggerData: {}, variables: sharedVariables };
      const inpB: NodeExecutionInput = { triggerData: {}, variables: sharedVariables };

      const resultA = await drainLoop(executor, nodeA, inpA);
      const resultB = await drainLoop(executor, nodeB, inpB);

      expect(resultA.iterations).toBe(2);
      expect(resultB.iterations).toBe(3);
      expect(resultA.stoppedEarly).toBe(false);
      expect(resultB.stoppedEarly).toBe(false);
    });

    it("leaves no state key behind after each loop completes", async () => {
      const nodeA = loopNode("cleanA", { itemsPath: "xs", itemVariable: "x" });
      const inp = makeInput({ xs: ["p", "q"] });

      await drainLoop(executor, nodeA, inp);

      expect(inp.variables["__loop_cleanA"]).toBeUndefined();
    });
  });

  describe("JSON round-trip persistence", () => {
    it("resumes correctly after variables are serialized and deserialized", async () => {
      const node = loopNode("rt1", { itemsPath: "nums", itemVariable: "num" });
      const inp = makeInput({ nums: [10, 20, 30] });

      const first = await executor.execute(node, inp, NOW, CTX);
      expect(first.kind === "continue" && first.branch).toBe("loop");
      expect(inp.variables["num"]).toBe(10);

      const roundTripped: Record<string, unknown> = JSON.parse(
        JSON.stringify(inp.variables),
      );
      const inp2: NodeExecutionInput = { triggerData: inp.triggerData, variables: roundTripped };

      const second = await executor.execute(node, inp2, NOW, CTX);
      expect(second.kind === "continue" && second.branch).toBe("loop");
      expect(inp2.variables["num"]).toBe(20);

      const third = await executor.execute(node, inp2, NOW, CTX);
      expect(third.kind === "continue" && third.branch).toBe("loop");
      expect(inp2.variables["num"]).toBe(30);

      const done = await executor.execute(node, inp2, NOW, CTX);
      expect(done.kind === "continue" && (done as { branch?: string }).branch).toBe("done");
    });
  });

  describe("misconfigured node", () => {
    it("fails when itemsPath is missing from config", async () => {
      const node = loopNode("bad1", {});
      const outcome = await executor.execute(node, makeInput({}), NOW, CTX);
      expect(outcome.kind).toBe("failed");
    });

    it("fails when maxIterations is not a positive integer", async () => {
      const node = loopNode("bad2", { itemsPath: "x", maxIterations: -1 });
      const outcome = await executor.execute(node, makeInput({ x: [1] }), NOW, CTX);
      expect(outcome.kind).toBe("failed");
    });
  });
});
