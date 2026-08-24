import {
  executeNode,
  MAX_DELAY_MS,
  type NodeExecutionInput,
} from "../workflow-node-executors";
import { WORKFLOW_NODE_TYPES, type WorkflowGraphNode } from "../workflow-graph";

const NOW = new Date("2026-08-23T10:00:00.000Z");

function node(
  nodeType: WorkflowGraphNode["data"]["nodeType"],
  configuration: Record<string, unknown> = {},
): WorkflowGraphNode {
  return { id: `${nodeType}-1`, data: { nodeType, configuration } };
}

const EMPTY: NodeExecutionInput = { triggerData: {}, variables: {} };

describe("executeNode — implemented types", () => {
  it("passes trigger data through", () => {
    const outcome = executeNode(
      node("trigger"),
      { triggerData: { ticketId: 7 }, variables: {} },
      NOW,
    );
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") return;
    expect(outcome.output).toEqual({ triggerData: { ticketId: 7 } });
  });

  it("halts on an end node", () => {
    expect(executeNode(node("end"), EMPTY, NOW).kind).toBe("halt");
  });

  it("branches true when the condition matches", () => {
    const outcome = executeNode(
      node("condition", {
        conditions: [{ field: "priority", op: "eq", value: "HIGH" }],
      }),
      { triggerData: { priority: "HIGH" }, variables: {} },
      NOW,
    );
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") return;
    expect(outcome.branch).toBe("true");
  });

  it("branches false when the condition does not match", () => {
    const outcome = executeNode(
      node("condition", {
        conditions: [{ field: "priority", op: "eq", value: "HIGH" }],
      }),
      { triggerData: { priority: "LOW" }, variables: {} },
      NOW,
    );
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") return;
    expect(outcome.branch).toBe("false");
  });

  it("honours match:any instead of always requiring every condition", () => {
    const config = {
      conditions: [
        { field: "priority", op: "eq", value: "HIGH" },
        { field: "status", op: "eq", value: "OPEN" },
      ],
      match: "any",
    };
    const input = { triggerData: { priority: "LOW", status: "OPEN" }, variables: {} };

    const any = executeNode(node("condition", config), input, NOW);
    const all = executeNode(
      node("condition", { ...config, match: "all" }),
      input,
      NOW,
    );

    expect(any.kind === "continue" && any.branch).toBe("true");
    expect(all.kind === "continue" && all.branch).toBe("false");
  });

  it("reads variables produced earlier in the run, not just trigger data", () => {
    const outcome = executeNode(
      node("condition", {
        conditions: [{ field: "score", op: "gt", value: 5 }],
      }),
      { triggerData: {}, variables: { score: 9 } },
      NOW,
    );
    expect(outcome.kind === "continue" && outcome.branch).toBe("true");
  });

  it("suspends a delay node until the computed instant", () => {
    const outcome = executeNode(node("delay", { minutes: 5 }), EMPTY, NOW);
    expect(outcome.kind).toBe("suspend");
    if (outcome.kind !== "suspend") return;
    expect(outcome.resumeAt.toISOString()).toBe("2026-08-23T10:05:00.000Z");
  });

  it("refuses a delay beyond the maximum rather than parking forever", () => {
    const outcome = executeNode(
      node("delay", { ms: MAX_DELAY_MS + 1 }),
      EMPTY,
      NOW,
    );
    expect(outcome.kind).toBe("failed");
  });

  it("fails a misconfigured node instead of treating it as a no-op", () => {
    expect(executeNode(node("delay", {}), EMPTY, NOW).kind).toBe("failed");
    expect(executeNode(node("condition", {}), EMPTY, NOW).kind).toBe("failed");
  });
});

describe("executeNode — types with no executor", () => {
  const unimplemented = ["approval", "action", "loop", "ai_action", "integration", "script"] as const;

  it.each(unimplemented)("fails %s explicitly rather than hanging", (nodeType) => {
    const outcome = executeNode(node(nodeType), EMPTY, NOW);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.error).toContain(nodeType);
  });

  it("covers every node type the builder can emit", () => {
    const handled = new Set<string>([
      "trigger",
      "condition",
      "delay",
      "end",
      ...unimplemented,
    ]);
    expect([...WORKFLOW_NODE_TYPES].filter((t) => !handled.has(t))).toEqual([]);
  });

  it("never returns continue for a type with no executor, which would skip it silently", () => {
    for (const nodeType of unimplemented) {
      expect(executeNode(node(nodeType), EMPTY, NOW).kind).not.toBe("continue");
    }
  });
});
