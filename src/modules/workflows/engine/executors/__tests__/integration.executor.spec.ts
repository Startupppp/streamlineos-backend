import {
  WorkflowIntegrationExecutor,
  type IntegrationLookup,
  type ComposioToolCaller,
} from "../integration.executor";
import type { NodeExecutionContext, NodeExecutionInput } from "../../node-outcome";
import type { WorkflowGraphNode } from "../../workflow-graph";

function makeNode(
  configuration: Record<string, unknown> | undefined,
): WorkflowGraphNode {
  return { id: "n1", data: { nodeType: "integration", configuration } };
}

const ctx: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: "user-1",
};

const emptyInput: NodeExecutionInput = { triggerData: {}, variables: {} };

const activeGmailConnection = {
  id: 42,
  status: "active",
  toolkit: "gmail",
  isPrimary: true,
};

const ownedRow = { composioConnectedAccountId: "composio-acct-abc" };

describe("WorkflowIntegrationExecutor", () => {
  let listConnections: jest.MockedFunction<IntegrationLookup["listConnections"]>;
  let ownedConnection: jest.MockedFunction<IntegrationLookup["ownedConnection"]>;
  let executeTool: jest.MockedFunction<ComposioToolCaller["executeTool"]>;
  let integrations: IntegrationLookup;
  let caller: ComposioToolCaller;
  let executor: WorkflowIntegrationExecutor;

  beforeEach(() => {
    listConnections = jest.fn();
    ownedConnection = jest.fn();
    executeTool = jest.fn();
    integrations = { listConnections, ownedConnection };
    caller = { executeTool };
    executor = new WorkflowIntegrationExecutor(integrations, caller);
  });

  describe("success path", () => {
    it("returns continue with sanitized provider output", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockResolvedValue({ messageId: "msg-1", threadId: "thread-1" });

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.com", subject: "Hi" } }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output["messageId"]).toBe("msg-1");
    });

    it("passes action, userId and composio account id to the caller", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockResolvedValue({});

      await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_GET_PROFILE", arguments: {} }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(executeTool).toHaveBeenCalledWith(
        "GMAIL_GET_PROFILE",
        "user-1",
        {},
        "composio-acct-abc",
      );
    });

    it("prefers the primary connection when multiple active connections exist", async () => {
      const secondary = { id: 10, status: "active", toolkit: "gmail", isPrimary: false };
      const primary = { id: 20, status: "active", toolkit: "gmail", isPrimary: true };
      listConnections.mockResolvedValue([secondary, primary]);
      ownedConnection.mockResolvedValue({ composioConnectedAccountId: "primary-acct" });
      executeTool.mockResolvedValue({});

      await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_GET_PROFILE" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(ownedConnection).toHaveBeenCalledWith("org-1", "user-1", 20);
    });

    it("wraps a non-object provider response in a data envelope", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockResolvedValue("plain string");

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_GET_PROFILE" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output["data"]).toBe("plain string");
    });
  });

  describe("no connection for the org", () => {
    it("returns failed when listConnections is empty", async () => {
      listConnections.mockResolvedValue([]);
      executeTool.mockResolvedValue({});

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/gmail/i);
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("returns failed when there is no active connection for the requested toolkit", async () => {
      listConnections.mockResolvedValue([
        { id: 1, status: "active", toolkit: "googlecalendar", isPrimary: true },
      ]);
      executeTool.mockResolvedValue({});

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/gmail/i);
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("ignores connections with non-active status", async () => {
      listConnections.mockResolvedValue([
        { id: 5, status: "needs_reauth", toolkit: "gmail", isPrimary: true },
      ]);
      executeTool.mockResolvedValue({});

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("returns failed when context has no userId", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        { ...ctx, userId: null },
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/user context/i);
      expect(listConnections).not.toHaveBeenCalled();
    });
  });

  describe("provider error", () => {
    it("returns failed when the caller rejects with an Error carrying a message", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockRejectedValue(new Error("Token expired"));

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toBe("Token expired");
    });

    it("resolves (never throws) on provider rejection", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockRejectedValue(new Error("Network timeout"));

      await expect(
        executor.execute(
          makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
          emptyInput,
          new Date(),
          ctx,
        ),
      ).resolves.toMatchObject({ kind: "failed", error: "Network timeout" });
    });

    it("uses a fallback message when a non-Error value is thrown", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockRejectedValue("string rejection");

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toBe("Integration call failed");
    });
  });

  describe("misconfigured node — caller is never invoked", () => {
    it("returns failed when toolkit is absent", async () => {
      const outcome = await executor.execute(
        makeNode({ action: "GMAIL_SEND_EMAIL" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("returns failed when action is absent", async () => {
      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("returns failed when configuration is undefined", async () => {
      const outcome = await executor.execute(
        makeNode(undefined),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(executeTool).not.toHaveBeenCalled();
    });
  });

  describe("oversized response truncation", () => {
    it("truncates a provider response exceeding 64 KiB and sets truncated:true", async () => {
      listConnections.mockResolvedValue([activeGmailConnection]);
      ownedConnection.mockResolvedValue(ownedRow);
      executeTool.mockResolvedValue({ body: "x".repeat(70_000) });

      const outcome = await executor.execute(
        makeNode({ toolkit: "gmail", action: "GMAIL_GET_MESSAGE" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output["truncated"]).toBe(true);
      expect(typeof outcome.output["preview"]).toBe("string");
    });
  });
});
