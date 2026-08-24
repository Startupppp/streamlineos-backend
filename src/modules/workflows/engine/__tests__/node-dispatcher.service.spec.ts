import { WorkflowNodeDispatcher } from "../node-dispatcher.service";
import { ActionExecutor } from "../executors/action.executor";
import { WorkflowAiActionExecutor } from "../executors/ai-action.executor";
import { WorkflowIntegrationExecutor } from "../executors/integration.executor";
import { WorkflowLoopExecutor } from "../executors/loop.executor";
import { WorkflowScriptExecutor } from "../executors/script.executor";
import type { WorkflowGraphNode } from "../workflow-graph";
import { WORKFLOW_NODE_TYPES } from "../workflow-graph";
import type { NodeExecutionContext, NodeExecutionInput } from "../node-outcome";

const NOW = new Date("2026-08-23T10:00:00.000Z");
const INPUT: NodeExecutionInput = { triggerData: {}, variables: {} };
const CONTEXT: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: null,
};

function nodeOf(nodeType: WorkflowGraphNode["data"]["nodeType"]): WorkflowGraphNode {
  return { id: `${nodeType}-1`, data: { nodeType, configuration: {} } };
}

function buildDispatcher() {
  const calls: string[] = [];
  const spy = (name: string) => {
    return {
      execute: () => {
        calls.push(name);
        return Promise.resolve({ kind: "continue" as const, output: {} });
      },
    };
  };

  const action = new ActionExecutor({
    executeAction: () => Promise.resolve({ ok: true, type: "email" }),
  });
  const aiAction = new WorkflowAiActionExecutor({
    invokeTextWithUsage: () => Promise.reject(new Error("unused")),
  });
  const integration = new WorkflowIntegrationExecutor(
    {
      listConnections: () => Promise.resolve([]),
      ownedConnection: () => Promise.resolve({ composioConnectedAccountId: "acct-1" }),
    },
    { executeTool: () => Promise.resolve({}) },
  );
  const loop = new WorkflowLoopExecutor();
  const script = new WorkflowScriptExecutor();

  Object.assign(action, spy("action"));
  Object.assign(aiAction, spy("ai_action"));
  Object.assign(integration, spy("integration"));
  Object.assign(loop, spy("loop"));
  Object.assign(script, spy("script"));

  return {
    dispatcher: new WorkflowNodeDispatcher(action, aiAction, integration, loop, script),
    calls,
  };
}

describe("WorkflowNodeDispatcher routes each node type to its executor", () => {
  const routed = ["action", "ai_action", "integration", "loop", "script"] as const;

  it.each(routed)("sends %s to its own executor", async (nodeType) => {
    const { dispatcher, calls } = buildDispatcher();
    await dispatcher.execute(nodeOf(nodeType), INPUT, NOW, CONTEXT);
    expect(calls).toEqual([nodeType]);
  });

  it("handles the pure node types inline without touching an injected executor", async () => {
    const { dispatcher, calls } = buildDispatcher();

    const trigger = await dispatcher.execute(nodeOf("trigger"), INPUT, NOW, CONTEXT);
    const end = await dispatcher.execute(nodeOf("end"), INPUT, NOW, CONTEXT);

    expect(trigger.kind).toBe("continue");
    expect(end.kind).toBe("halt");
    expect(calls).toEqual([]);
  });

  it("still fails approval explicitly, naming what is missing", async () => {
    const { dispatcher } = buildDispatcher();
    const outcome = await dispatcher.execute(nodeOf("approval"), INPUT, NOW, CONTEXT);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.error).toContain("approval");
    expect(outcome.error).toContain("domain-scoped");
  });

  it("covers every node type the builder can emit, so a new type cannot be silently unrouted", async () => {
    const { dispatcher } = buildDispatcher();

    for (const nodeType of WORKFLOW_NODE_TYPES) {
      const outcome = await dispatcher.execute(nodeOf(nodeType), INPUT, NOW, CONTEXT);
      expect(["continue", "suspend", "halt", "failed"]).toContain(outcome.kind);
    }
  });
});
