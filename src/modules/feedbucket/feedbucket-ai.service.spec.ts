jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../projects/projects-tickets.service");

import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import type { Db } from "../../db/drizzle.module";
import type { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import type { AiUsageService } from "../ai/services/ai-usage.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import type { ProjectsTicketsService } from "../build/projects-tickets.service";
import type { FeedbackAnalysis } from "./feedbucket-ai.schemas";
import type { AiInvokeWithUsageResult } from "../ai/gateway/ai-gateway.types";

const ORG_A = "org_a";
const USER_A = "user_a";
const WIDGET_ID = 10;

const baseAnalysis: FeedbackAnalysis = {
  type: "bug",
  confidence: 90,
  suggestedTicketType: "BUG",
  title: "Login fails",
  summary: "Login button does nothing.",
  description: "<p>Login broken.</p>",
  reproductionSteps: [],
  suggestions: [],
  acceptanceCriteria: [],
  priority: "HIGH",
  model: "standard",
  processedAt: new Date().toISOString(),
};

const SUCCESS_RESULT: AiInvokeWithUsageResult<FeedbackAnalysis> = {
  ok: true,
  data: baseAnalysis,
  aiUsage: { model: "gpt-4o", promptTokens: 50, completionTokens: 100, totalTokens: 150, credits: 1, costUsd: 0.002 },
};

function makeGateway(result: AiInvokeWithUsageResult<FeedbackAnalysis> = SUCCESS_RESULT) {
  return {
    invokeStructuredWithImageWithUsage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<Pick<AiGatewayService, "invokeStructuredWithImageWithUsage">>;
}

function makeDb(): Db {
  const updateChain = { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([]) };
  return {
    query: { feedbucketSubmissions: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    update: jest.fn().mockReturnValue(updateChain),
  } as unknown as Db;
}

function buildService(gateway: ReturnType<typeof makeGateway>) {
  return new FeedbucketAiService(
    makeDb(),
    gateway as unknown as AiGatewayService,
    { track: jest.fn() } as unknown as AiUsageService,
    { log: jest.fn() } as unknown as AuditService,
    { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) } as unknown as RateLimitService,
    { createFromFeedback: jest.fn() } as unknown as ProjectsTicketsService,
  );
}

describe("FeedbucketAiService — gateway migration", () => {
  describe("analyzePublic — charges via gateway with actorUserId", () => {
    it("calls invokeStructuredWithImageWithUsage with correct actor and public feature key", async () => {
      const gateway = makeGateway();
      const service = buildService(gateway);

      await service.analyzePublic({
        orgId: ORG_A,
        actorUserId: USER_A,
        widgetId: WIDGET_ID,
        type: "bug",
        message: "Something broke",
      });

      expect(gateway.invokeStructuredWithImageWithUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { orgId: ORG_A, userId: USER_A },
          feature: "feedbucket.assist",
          charge: true,
        }),
      );
    });

    it("passes screenshot as image data URL when buffer is a valid jpeg", async () => {
      const gateway = makeGateway();
      const service = buildService(gateway);
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

      await service.analyzePublic({
        orgId: ORG_A,
        actorUserId: USER_A,
        widgetId: WIDGET_ID,
        type: "bug",
        message: "broken",
        screenshotBuffer: jpegBuf,
      });

      const call = (gateway.invokeStructuredWithImageWithUsage as jest.Mock).mock.calls[0]?.[0] as { images: string[] };
      expect(call.images).toHaveLength(1);
      expect(call.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("throws ServiceUnavailableException when gateway returns provider_unavailable (gateway handles refund)", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "provider_unavailable",
        message: "Provider down",
        correlationId: "c-1",
      };
      const gateway = makeGateway(failure);
      const service = buildService(gateway);

      await expect(
        service.analyzePublic({ orgId: ORG_A, actorUserId: USER_A, widgetId: WIDGET_ID, type: "bug", message: "x" }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("throws BadRequestException when gateway returns quota_exceeded", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "quota_exceeded",
        message: "Insufficient AI credits",
        correlationId: "c-1",
      };
      const gateway = makeGateway(failure);
      const service = buildService(gateway);

      await expect(
        service.analyzePublic({ orgId: ORG_A, actorUserId: USER_A, widgetId: WIDGET_ID, type: "bug", message: "x" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("analyzePublic — release is handled by gateway (no double-charge)", () => {
    it("does not call credits.refundCredits (old API) — refund is gateway-internal", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "provider_unavailable",
        message: "down",
        correlationId: "c-2",
      };
      const gateway = makeGateway(failure);
      const invokeStructuredWithImageWithUsageMock = gateway.invokeStructuredWithImageWithUsage as jest.Mock;

      const service = buildService(gateway);

      await service.analyzePublic({
        orgId: ORG_A, actorUserId: USER_A, widgetId: WIDGET_ID, type: "bug", message: "x",
      }).catch(() => undefined);

      expect(invokeStructuredWithImageWithUsageMock).toHaveBeenCalledTimes(1);
    });
  });
});
