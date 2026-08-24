import { WorkflowScriptExecutor } from "../script.executor";
import type { NodeExecutionContext, NodeExecutionInput } from "../../node-outcome";
import type { WorkflowGraphNode } from "../../workflow-graph";

function makeNode(
  code: string,
  opts?: { timeoutMs?: number; outputVariable?: string },
): WorkflowGraphNode {
  return {
    id: "test-node",
    data: { nodeType: "script", configuration: { code, ...opts } },
  };
}

const emptyInput: NodeExecutionInput = { triggerData: {}, variables: {} };

const ctx: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: null,
};

const now = new Date();

let executor: WorkflowScriptExecutor;

beforeAll(async () => {
  executor = new WorkflowScriptExecutor();
  await executor.onModuleInit();
}, 15_000);

describe("WorkflowScriptExecutor", () => {
  describe("successful execution", () => {
    it("returns a primitive value wrapped under result", async () => {
      const node = makeNode("return 42;");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("continue");
      if (outcome.kind === "continue") expect(outcome.output["result"]).toBe(42);
    });

    it("returns an object value", async () => {
      const node = makeNode('return { greeting: "hello" };');
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("continue");
      if (outcome.kind === "continue")
        expect(outcome.output["result"]).toEqual({ greeting: "hello" });
    });

    it("uses outputVariable as the key when configured", async () => {
      const node = makeNode("return 99;", { outputVariable: "score" });
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("continue");
      if (outcome.kind === "continue") {
        expect(outcome.output["score"]).toBe(99);
        expect(outcome.output["result"]).toBeUndefined();
      }
    });

    it("reads the merged payload inside the script", async () => {
      const input: NodeExecutionInput = {
        triggerData: { event: "signup" },
        variables: { userId: "u-123" },
      };
      const node = makeNode("return { event: payload.event, uid: payload.userId };");
      const outcome = await executor.execute(node, input, now, ctx);
      expect(outcome.kind).toBe("continue");
      if (outcome.kind === "continue")
        expect(outcome.output["result"]).toEqual({
          event: "signup",
          uid: "u-123",
        });
    });

    it("returns null (JSON-serialisable) without error", async () => {
      const node = makeNode("return null;");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("continue");
    });
  });

  describe("error cases", () => {
    it("returns failed for a syntax error", async () => {
      const node = makeNode("this is not valid javascript %%%");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });

    it("returns failed for a thrown Error", async () => {
      const node = makeNode('throw new Error("intentional failure");');
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed")
        expect(outcome.error).toContain("intentional failure");
    });

    it("returns failed for a thrown string", async () => {
      const node = makeNode('throw "bad thing happened";');
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });

    it("returns failed for a non-serialisable result (function)", async () => {
      const node = makeNode("return function nope(){};");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed")
        expect(outcome.error).toContain("non-JSON-serialisable");
    });

    it("returns failed for missing code in config", async () => {
      const node: WorkflowGraphNode = {
        id: "n",
        data: { nodeType: "script", configuration: {} },
      };
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") expect(outcome.error).toContain("misconfigured");
    });

    it("rejects timeoutMs above the cap", async () => {
      const node = makeNode("return 1;", { timeoutMs: 999_999 });
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });
  });

  describe("resource limits", () => {
    it(
      "interrupts an infinite loop before the deadline",
      async () => {
        const node = makeNode("while(true){}", { timeoutMs: 200 });
        const start = Date.now();
        const outcome = await executor.execute(node, emptyInput, now, ctx);
        const elapsed = Date.now() - start;
        expect(outcome.kind).toBe("failed");
        expect(elapsed).toBeLessThan(3_000);
      },
      5_000,
    );

    it(
      "fails when script exceeds the memory limit",
      async () => {
        const node = makeNode(
          "var a = 'x'; while(true){ a = a + a; }",
          { timeoutMs: 2_000 },
        );
        const outcome = await executor.execute(node, emptyInput, now, ctx);
        expect(outcome.kind).toBe("failed");
      },
      5_000,
    );
  });

  describe("sandbox escape attempts", () => {
    it("cannot access process via this.constructor.constructor", async () => {
      const node = makeNode(
        "return this.constructor.constructor('return process')();",
      );
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      if (outcome.kind === "continue") {
        expect(outcome.output["result"]).toBeUndefined();
      } else {
        expect(outcome.kind).toBe("failed");
      }
    });

    it("cannot access process directly — throws ReferenceError", async () => {
      const node = makeNode("return process.env;");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed")
        expect(outcome.error).toMatch(/ReferenceError|process/i);
    });

    it("globalThis.process is undefined — host process is not exposed", async () => {
      const node = makeNode("return globalThis.process;");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      if (outcome.kind === "continue") {
        expect(outcome.output["result"]).toBeUndefined();
      } else {
        expect(outcome.kind).toBe("failed");
      }
    });

    it("require is not defined", async () => {
      const node = makeNode("return require('fs');");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });

    it("dynamic import() fails in the sandbox", async () => {
      const node = makeNode('return import("fs");', { timeoutMs: 500 });
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });

    it("cannot read host filesystem (no fs)", async () => {
      const node = makeNode("return require('fs').readFileSync('/etc/passwd', 'utf8');");
      const outcome = await executor.execute(node, emptyInput, now, ctx);
      expect(outcome.kind).toBe("failed");
    });
  });
});
