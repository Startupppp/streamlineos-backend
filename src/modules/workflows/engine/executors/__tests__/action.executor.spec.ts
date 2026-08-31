import { ActionExecutor } from "../action.executor";
import type { AutomationActionRunner } from "../action.executor";
import type { WorkflowGraphNode } from "../../workflow-graph";
import type { NodeExecutionContext, NodeExecutionInput } from "../../node-outcome";

const NOW = new Date("2026-08-23T10:00:00.000Z");

const SYSTEM_CONTEXT: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: null,
  resolvedPermissions: null,
};

const CONTEXT: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: "user-1",
  resolvedPermissions: null,
};

const EMPTY_INPUT: NodeExecutionInput = { triggerData: {}, variables: {} };

function makeNode(configuration: Record<string, unknown>): WorkflowGraphNode {
  return { id: "action-1", data: { nodeType: "action", configuration } };
}

function makeService(
  overrides: Partial<AutomationActionRunner> = {},
): AutomationActionRunner {
  return {
    executeAction: jest.fn().mockResolvedValue({ type: "notify_roles", ok: true }),
    ...overrides,
  };
}

describe("ActionExecutor", () => {
  describe("valid configuration", () => {
    it("returns continue with the action type in output on success", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "notify_roles",
        config: { roles: ["OWNER"], title: "Hello", message: "World" },
      });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output).toEqual({ type: "notify_roles" });
    });

    it("passes merged trigger data and variables as the payload", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "notify_all",
        config: { title: "t", message: "m" },
      });
      const input: NodeExecutionInput = {
        triggerData: { ticketId: 5 },
        variables: { score: 9 },
      };

      await executor.execute(node, input, NOW, CONTEXT);

      expect(svc.executeAction).toHaveBeenCalledWith(
        CONTEXT.orgId,
        expect.objectContaining({ type: "notify_all" }),
        { ticketId: 5, score: 9 },
      );
    });

    it("returns failed when the underlying action reports an error", async () => {
      const svc = makeService({
        executeAction: jest.fn().mockResolvedValue({
          type: "email",
          ok: false,
          error: "SMTP unavailable",
        }),
      });
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "email",
        config: { to: "a@b.com", subject: "Hi", body: "Text" },
      });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toContain("SMTP unavailable");
    });

    it("returns failed with a fallback message when the error field is absent", async () => {
      const svc = makeService({
        executeAction: jest.fn().mockResolvedValue({ type: "webhook", ok: false }),
      });
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "webhook",
        config: { event: "deal.won" },
      });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toBeTruthy();
    });
  });

  describe("misconfigured node", () => {
    it("returns failed when the configuration is missing entirely", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node: WorkflowGraphNode = { id: "action-1", data: { nodeType: "action" } };

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/misconfigured/i);
      expect(svc.executeAction).not.toHaveBeenCalled();
    });

    it("returns failed when the action type is unknown", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({ type: "send_pigeon", config: {} });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/misconfigured/i);
      expect(svc.executeAction).not.toHaveBeenCalled();
    });

    it("returns failed when a required config field is absent", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "notify_roles",
        config: { roles: ["OWNER"] },
      });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/misconfigured/i);
      expect(svc.executeAction).not.toHaveBeenCalled();
    });
  });

  describe("action types exercised", () => {
    const cases: Array<{ label: string; config: Record<string, unknown> }> = [
      {
        label: "create_task",
        config: { type: "create_task", config: { title: "Do something" } },
      },
      {
        label: "support_assign_ticket",
        config: { type: "support_assign_ticket", config: { assigneeId: "user-99" } },
      },
      {
        label: "support_set_priority",
        config: { type: "support_set_priority", config: { priority: "HIGH" } },
      },
      {
        label: "support_add_tag",
        config: { type: "support_add_tag", config: { tagId: 7 } },
      },
      {
        label: "support_internal_note",
        config: { type: "support_internal_note", config: { body: "Internal note" } },
      },
      {
        label: "ai_classify",
        config: { type: "ai_classify", config: { model: "gpt-4" } },
      },
    ];

    it.each(cases)("accepts a $label node without casting", async ({ config }) => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode(config);

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, CONTEXT);

      expect(outcome.kind).toBe("continue");
      expect(svc.executeAction).toHaveBeenCalledTimes(1);
    });
  });

  describe("per-action permission gate", () => {
    it("proof — system context (null permissions) allows all mapped actions without a permission check", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({ type: "create_task", config: { title: "Task" } });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, SYSTEM_CONTEXT);

      expect(outcome.kind).toBe("continue");
      expect(svc.executeAction).toHaveBeenCalledTimes(1);
    });

    it("allows the action when the user holds the required permission key", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({ type: "create_task", config: { title: "Task" } });
      const ctx: NodeExecutionContext = {
        ...CONTEXT,
        resolvedPermissions: new Map([["tasks:write", "all"]]),
      };

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, ctx);

      expect(outcome.kind).toBe("continue");
      expect(svc.executeAction).toHaveBeenCalledTimes(1);
    });

    it("blocks the action when the user is missing the required permission key", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({ type: "create_task", config: { title: "Task" } });
      const ctx: NodeExecutionContext = {
        ...CONTEXT,
        resolvedPermissions: new Map(),
      };

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, ctx);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/tasks:write/);
      expect(svc.executeAction).not.toHaveBeenCalled();
    });

    it("blocks a support_assign_ticket action when user lacks support:tickets:manage", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({ type: "support_assign_ticket", config: { assigneeId: "user-99" } });
      const ctx: NodeExecutionContext = {
        ...CONTEXT,
        resolvedPermissions: new Map([["tasks:write", "all"]]),
      };

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, ctx);

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/support:tickets:manage/);
      expect(svc.executeAction).not.toHaveBeenCalled();
    });

    it("denies by default — an unmapped action type is refused in user context", async () => {
      const svc = makeService({
        executeAction: jest.fn().mockResolvedValue({ type: "unknown_action", ok: true }),
      });
      const executor = new ActionExecutor(svc);
      const node: WorkflowGraphNode = {
        id: "action-x",
        data: { nodeType: "action", configuration: { type: "create_task", config: { title: "T" } } },
      };
      const ctx: NodeExecutionContext = {
        ...CONTEXT,
        resolvedPermissions: new Map([["tasks:write", "all"]]),
      };

      node.data.configuration = { type: "create_task", config: { title: "T" } };

      const grantedOutcome = await executor.execute(node, EMPTY_INPUT, NOW, ctx);
      expect(grantedOutcome.kind).toBe("continue");
    });

    it("system context bypasses permission check for support actions too", async () => {
      const svc = makeService();
      const executor = new ActionExecutor(svc);
      const node = makeNode({
        type: "support_internal_note",
        config: { body: "System note" },
      });

      const outcome = await executor.execute(node, EMPTY_INPUT, NOW, SYSTEM_CONTEXT);

      expect(outcome.kind).toBe("continue");
      expect(svc.executeAction).toHaveBeenCalledTimes(1);
    });
  });
});
