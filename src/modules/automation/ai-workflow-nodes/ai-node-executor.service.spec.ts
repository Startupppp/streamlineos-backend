import { HttpException, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AiNodeExecutorService } from "./ai-node-executor.service";
import { WorkflowAiNodeHandler } from "./ai-job-handlers/workflow-ai-node.handler";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AiConfirmationService } from "../../ai/confirmation/ai-confirmation.service";
import { AiJobsService } from "../../ai/jobs/ai-jobs.service";
import { AiJobHandlerRegistry } from "../../ai/jobs/ai-job-handler";
import type { AiInvokeResult } from "../../ai/core/gateway/ai-gateway.types";
import type { AiNodeType } from "./ai-node-types";

const ORG_ID = "org-test-1";
const USER_ID = "user-test-1";
const JOB_ID = 42;

const mockGateway = {
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
};
const mockAudit = { log: jest.fn() };
const mockConfirmation = { propose: jest.fn() };
const mockJobs = { fail: jest.fn(), complete: jest.fn(), enqueue: jest.fn() };

function makeSuccess<T>(data: T): AiInvokeResult<T> {
  return {
    ok: true,
    data,
    model: "gpt-4o-mini",
    latencyMs: 42,
    correlationId: "corr-1",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function makeFailure(kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output"): AiInvokeResult<never> {
  return { ok: false, kind, message: `AI error: ${kind}`, correlationId: "corr-fail" };
}

async function buildModule(): Promise<{ executor: AiNodeExecutorService; handler: WorkflowAiNodeHandler }> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiNodeExecutorService,
      WorkflowAiNodeHandler,
      { provide: AiGatewayService, useValue: mockGateway },
      { provide: AuditService, useValue: mockAudit },
      { provide: AiConfirmationService, useValue: mockConfirmation },
      { provide: AiJobsService, useValue: mockJobs },
      { provide: AiJobHandlerRegistry, useValue: { register: jest.fn() } },
    ],
  }).compile();

  return {
    executor: module.get(AiNodeExecutorService),
    handler: module.get(WorkflowAiNodeHandler),
  };
}

describe("AiNodeExecutorService", () => {
  let executor: AiNodeExecutorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ executor } = await buildModule());
  });

  // classify
  describe("classify node", () => {
    const nodeType: AiNodeType = "classify";
    const config = { labels: ["urgent", "normal"], field: "priority" };
    const payload = { priority: "critical issue" };

    it("returns ok=true with the matching label when gateway succeeds", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeSuccess({ label: "urgent" }));

      const result = await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toEqual({ label: "urgent" });
    });

    it("passes labels constraint to the gateway call", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeSuccess({ label: "normal" }));

      await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ actor: expect.objectContaining({ orgId: ORG_ID }) }),
      );
    });

    it("throws ServiceUnavailableException when gateway returns invalid_output", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeFailure("invalid_output"));

      await expect(
        executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload),
      ).rejects.toThrow();
    });
  });

  // summarize
  describe("summarize node", () => {
    const nodeType: AiNodeType = "summarize";
    const config = { fields: ["subject", "body"] };
    const payload = { subject: "Login issue", body: "Can't sign in" };

    it("returns ok=true with a summary string when gateway succeeds", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeSuccess("User reports login issue"));

      const result = await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toEqual({ summary: "User reports login issue" });
    });

    it("calls the gateway with a prompt that concatenates the configured fields", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeSuccess("summary"));

      await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      const callOpts = (mockGateway.invokeText as jest.Mock).mock.calls[0][0] as { prompt: { user: string } };
      expect(callOpts.prompt.user).toContain("Login issue");
      expect(callOpts.prompt.user).toContain("Can't sign in");
    });
  });

  // extract
  describe("extract node", () => {
    const nodeType: AiNodeType = "extract";
    const config = {
      fields: [
        { name: "customerName", description: "Customer's full name", type: "string" },
        { name: "accountNumber", description: "Account number", type: "string" },
      ],
    };
    const payload = { body: "Customer John Doe, account 12345, is requesting a refund." };

    it("returns ok=true with extracted object when gateway succeeds", async () => {
      const gatewayData = { extracted: { customerName: "John Doe", accountNumber: "12345" } };
      mockGateway.invokeStructured.mockResolvedValueOnce(makeSuccess(gatewayData));

      const result = await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toEqual(gatewayData);
    });

    it("passes field descriptors to the gateway schema", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeSuccess({ customerName: "Jane", accountNumber: "99" }));

      await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
    });
  });

  // routing_suggestion — approval-gating
  describe("routing_suggestion node", () => {
    const nodeType: AiNodeType = "routing_suggestion";
    const config = { options: ["billing", "technical", "general"], field: "subject" };
    const payload = { subject: "Can't pay invoice", body: "My payment keeps failing." };

    it("calls AiConfirmationService.propose and attaches proposalToken to the output", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(
        makeSuccess({ suggestion: "billing", reasoning: "Payment related" }),
      );
      mockConfirmation.propose.mockResolvedValueOnce({
        proposalId: 7,
        token: "7.1234567890.abc123",
        expiresAt: new Date(Date.now() + 120_000),
      });

      const result = await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(mockConfirmation.propose).toHaveBeenCalledTimes(1);
      expect(result.proposalToken).toBe("7.1234567890.abc123");
      expect(result.output).toMatchObject({ proposalToken: "7.1234567890.abc123", suggestion: "billing" });
    });

    it("does NOT execute any mutation — output is suggestion + token only, no write side-effects", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(
        makeSuccess({ suggestion: "technical", reasoning: "Tech issue" }),
      );
      mockConfirmation.propose.mockResolvedValueOnce({
        proposalId: 8,
        token: "8.1234567890.def456",
        expiresAt: new Date(Date.now() + 120_000),
      });

      const result = await executor.executeNode(ORG_ID, USER_ID, nodeType, config, payload);

      expect(result.ok).toBe(true);
      expect(mockJobs.enqueue).not.toHaveBeenCalled();
      expect(mockJobs.complete).not.toHaveBeenCalled();
    });
  });

  // feature flag disabled


  // quota_exceeded propagation
  describe("quota_exceeded from gateway", () => {
    it("propagates as ok=false or throws HttpException 402 — never silently discards the failure", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeFailure("quota_exceeded"));

      let result: Awaited<ReturnType<typeof executor.executeNode>> | undefined;
      let thrown: unknown;
      try {
        result = await executor.executeNode(
          ORG_ID,
          USER_ID,
          "classify",
          { labels: ["urgent", "normal"], field: "priority" },
          { priority: "high" },
        );
      } catch (err) {
        thrown = err;
      }

      if (thrown !== undefined) {
        expect(thrown).toBeInstanceOf(HttpException);
        expect((thrown as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      } else {
        expect(result?.ok).toBe(false);
      }
    });
  });
});

// WorkflowAiNodeHandler
describe("WorkflowAiNodeHandler", () => {
  let executor: AiNodeExecutorService;
  let handler: WorkflowAiNodeHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ executor, handler } = await buildModule());
  });

  it("has type 'workflow.ai_node'", () => {
    expect(handler.type).toBe("workflow.ai_node");
  });

  describe("handle — success", () => {
    it("delegates to executeNode and returns its output as a Record", async () => {
      jest.spyOn(executor, "executeNode").mockResolvedValueOnce({
        ok: true,
        output: { summary: "brief summary" },
      });

      const result = await handler.handle({
        id: JOB_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        payload: {
          nodeType: "summarize",
          nodeConfig: { fields: ["body"] },
          automationPayload: { body: "Some text" },
        },
      });

      expect(result).toMatchObject({ ok: true });
      expect(mockJobs.complete).toHaveBeenCalledWith(JOB_ID, expect.any(Object));
    });
  });

  describe("handle — executeNode throws", () => {
    it("records failure via jobs.fail() and returns ok=false when executeNode throws", async () => {
      jest.spyOn(executor, "executeNode").mockRejectedValueOnce(
        new ServiceUnavailableException("provider down"),
      );

      const result = await handler.handle({
        id: JOB_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        payload: {
          nodeType: "summarize",
          nodeConfig: { fields: ["body"] },
          automationPayload: { body: "Some text" },
        },
      });

      expect(result).toMatchObject({ ok: false });
      expect(mockJobs.fail).toHaveBeenCalledWith(JOB_ID, expect.any(String));
    });

    it("passes the error message to jobs.fail() so the job is retried or dead-lettered", async () => {
      jest.spyOn(executor, "executeNode").mockRejectedValueOnce(new Error("gateway unavailable"));

      const result = await handler.handle({
        id: JOB_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        payload: {
          nodeType: "classify",
          nodeConfig: { labels: ["a", "b"], field: "status" },
          automationPayload: {},
        },
      });

      expect(result).toMatchObject({ ok: false });
      expect(mockJobs.fail).toHaveBeenCalledWith(JOB_ID, "gateway unavailable");
    });
  });

  describe("handle — missing payload fields", () => {
    it("returns ok=false or throws when nodeType is absent from the job payload", async () => {
      let result: Record<string, unknown> | undefined;
      let thrown: unknown;
      try {
        result = await handler.handle({
          id: JOB_ID,
          orgId: ORG_ID,
          userId: USER_ID,
          payload: { nodeConfig: {}, automationPayload: {} },
        });
      } catch (err) {
        thrown = err;
      }

      if (thrown !== undefined) {
        expect(thrown).toBeInstanceOf(Error);
      } else {
        expect(result).toMatchObject({ ok: false });
      }
    });
  });
});
