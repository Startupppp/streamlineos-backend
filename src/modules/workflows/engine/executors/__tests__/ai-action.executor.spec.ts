import {
  WorkflowAiActionExecutor,
  type AiTextGateway,
} from "../ai-action.executor";
import type { NodeExecutionContext, NodeExecutionInput } from "../../node-outcome";
import type { WorkflowGraphNode } from "../../workflow-graph";
import type {
  AiInvokeWithUsageResult,
  AiUsageMeta,
} from "../../../../ai/core/gateway/ai-gateway.types";

function makeNode(
  configuration: Record<string, unknown> | undefined,
): WorkflowGraphNode {
  return { id: "n1", data: { nodeType: "ai_action", configuration } };
}

const ctx: NodeExecutionContext = {
  orgId: "org-1",
  executionId: "exec-1",
  userId: "user-1",
  resolvedPermissions: null,
};

const emptyInput: NodeExecutionInput = {
  triggerData: {},
  variables: {},
};

const stubUsage: AiUsageMeta = {
  model: "gpt-4o-mini",
  promptTokens: 5,
  completionTokens: 10,
  totalTokens: 15,
  credits: 0.001,
  costUsd: 0.000001,
};

function ok(data: string): AiInvokeWithUsageResult<string> {
  // F6. The with-usage success branch carries the gateway's correlation id.
  return { ok: true, data, aiUsage: stubUsage, correlationId: "corr-stub" };
}

function fail(
  kind: "quota_exceeded" | "not_configured" | "provider_unavailable" | "invalid_output",
  message = "some error",
): AiInvokeWithUsageResult<string> {
  return { ok: false, kind, message, correlationId: "corr-1" };
}

describe("WorkflowAiActionExecutor", () => {
  let invokeTextWithUsage: jest.MockedFunction<
    AiTextGateway["invokeTextWithUsage"]
  >;
  let gateway: AiTextGateway;
  let executor: WorkflowAiActionExecutor;

  beforeEach(() => {
    invokeTextWithUsage = jest.fn();
    gateway = { invokeTextWithUsage };
    executor = new WorkflowAiActionExecutor(gateway);
  });

  describe("success path", () => {
    it("returns continue with text and aiUsage", async () => {
      invokeTextWithUsage.mockResolvedValue(ok("Generated text"));

      const outcome = await executor.execute(
        makeNode({ prompt: "Write a summary" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output["text"]).toBe("Generated text");
      expect(outcome.output["aiUsage"]).toBe(stubUsage);
    });

    it("stores result in outputVariable when configured", async () => {
      invokeTextWithUsage.mockResolvedValue(ok("hello"));

      const outcome = await executor.execute(
        makeNode({ prompt: "Say hello", outputVariable: "greeting" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("continue");
      if (outcome.kind !== "continue") return;
      expect(outcome.output["greeting"]).toBe("hello");
    });

    it("interpolates {{var}} tokens from merged triggerData and variables", async () => {
      invokeTextWithUsage.mockResolvedValue(ok("ok"));

      await executor.execute(
        makeNode({ prompt: "Hello {{name}}, ticket {{ticketId}}" }),
        { triggerData: { ticketId: "T-42" }, variables: { name: "Alice" } },
        new Date(),
        ctx,
      );

      expect(invokeTextWithUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.objectContaining({
            user: "Hello Alice, ticket T-42",
          }),
        }),
      );
    });

    it("passes tier, maxTokens and charge:true to the gateway", async () => {
      invokeTextWithUsage.mockResolvedValue(ok("ok"));

      await executor.execute(
        makeNode({ prompt: "test", model: "standard", maxOutputTokens: 500 }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(invokeTextWithUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: "standard",
          maxTokens: 500,
          charge: true,
        }),
      );
    });

    it("passes orgId and userId as actor", async () => {
      invokeTextWithUsage.mockResolvedValue(ok("ok"));

      await executor.execute(
        makeNode({ prompt: "test" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(invokeTextWithUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { orgId: "org-1", userId: "user-1" },
        }),
      );
    });
  });

  describe("failure paths — all produce kind:failed and never throw", () => {
    it("returns failed with credit-exhaustion message on quota_exceeded", async () => {
      invokeTextWithUsage.mockResolvedValue(fail("quota_exceeded"));

      const outcome = await executor.execute(
        makeNode({ prompt: "test" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/credit quota exhausted/i);
    });

    it("resolves (not throws) on quota_exceeded", async () => {
      invokeTextWithUsage.mockResolvedValue(fail("quota_exceeded", "no credits"));

      await expect(
        executor.execute(makeNode({ prompt: "test" }), emptyInput, new Date(), ctx),
      ).resolves.toMatchObject({ kind: "failed" });
    });

    it("returns failed on not_configured", async () => {
      invokeTextWithUsage.mockResolvedValue(fail("not_configured"));

      const outcome = await executor.execute(
        makeNode({ prompt: "test" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/not configured/i);
    });

    it("returns failed on provider_unavailable", async () => {
      invokeTextWithUsage.mockResolvedValue(
        fail("provider_unavailable", "Service down"),
      );

      const outcome = await executor.execute(
        makeNode({ prompt: "test" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/temporarily unavailable/i);
    });

    it("returns failed on invalid_output", async () => {
      invokeTextWithUsage.mockResolvedValue(fail("invalid_output"));

      const outcome = await executor.execute(
        makeNode({ prompt: "test" }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.error).toMatch(/unexpected/i);
    });
  });

  describe("misconfigured node — gateway is never called", () => {
    it("returns failed when prompt is absent", async () => {
      const outcome = await executor.execute(
        makeNode({}),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(invokeTextWithUsage).not.toHaveBeenCalled();
    });

    it("returns failed when configuration is undefined", async () => {
      const outcome = await executor.execute(
        makeNode(undefined),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(invokeTextWithUsage).not.toHaveBeenCalled();
    });

    it("returns failed when maxOutputTokens exceeds the 2000 cap", async () => {
      const outcome = await executor.execute(
        makeNode({ prompt: "test", maxOutputTokens: 9999 }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(invokeTextWithUsage).not.toHaveBeenCalled();
    });

    it("returns failed when prompt exceeds the 4000-character cap", async () => {
      const outcome = await executor.execute(
        makeNode({ prompt: "x".repeat(4001) }),
        emptyInput,
        new Date(),
        ctx,
      );

      expect(outcome.kind).toBe("failed");
      expect(invokeTextWithUsage).not.toHaveBeenCalled();
    });
  });
});
