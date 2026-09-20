jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../../build/core/projects-tickets.service");

import { ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { FeedbucketAiService } from "../feedbucket-ai.service";
import type { Db } from "../../../db/drizzle.module";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import type { ProjectsTicketsService } from "../../build/core/projects-tickets.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { FeedbackAnalysis } from "../feedbucket-ai.schemas";
import type {
  AiInvokeWithUsageResult,
  AiInvokeWithUsageSuccess,
} from "../../ai/core/gateway/ai-gateway.types";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG_A = "org_a";
const ORG_B = "org_b";
const USER_A = "user_a";
const SUB_ID = 1;

const baseWidget = {
  id: 10,
  orgId: ORG_A,
  projectId: 99,
  project: { id: 99, orgId: ORG_A },
  name: "Widget",
  publicKey: "k",
  allowedDomains: [],
  autoCreateTicket: false,
  defaultTicketType: "BUG",
  isActive: true,
  theme: null,
  createdBy: USER_A,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    orgId: ORG_A,
    widgetId: 10,
    widget: baseWidget,
    type: "bug",
    status: "open",
    priority: null,
    message: "The login button does nothing when clicked",
    pageUrl: "https://app.example.com/login",
    screenshotUrl: null,
    screenshotKey: null,
    metadata: { browser: "Chrome", browserVersion: "125", os: "macOS" },
    consoleLogs: [{ level: "error", message: "Uncaught TypeError: cannot read property" }],
    reporterName: "Test User",
    reporterEmail: "test@example.com",
    assigneeId: null,
    linkedTicketId: null,
    aiType: null,
    aiConfidence: null,
    aiAnalysis: null,
    aiModel: null,
    aiProcessedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    networkLogs: null,
    ...overrides,
  };
}

const baseAnalysis: FeedbackAnalysis = {
  type: "bug",
  confidence: 92,
  suggestedTicketType: "BUG",
  title: "Login button unresponsive on click",
  summary: "User reports the login button does nothing when clicked.",
  description: "<p>The login button does not trigger any action when clicked.</p>",
  reproductionSteps: ["Go to /login", "Enter credentials", "Click login button", "Observe nothing happens"],
  suggestions: ["Check for JS errors in console", "Verify event handler attachment"],
  acceptanceCriteria: [],
  priority: "HIGH",
  model: "standard",
  processedAt: new Date().toISOString(),
};

// Typed as the success branch, not the union: the spread below only
// type-checks when the compiler knows which branch it is spreading.
const baseGatewaySuccess: AiInvokeWithUsageSuccess<FeedbackAnalysis> = {
  ok: true,
  data: baseAnalysis,
  aiUsage: { model: "gpt-4o", promptTokens: 50, completionTokens: 100, totalTokens: 150, credits: 1, costUsd: 0.002 },
  // F6. The success branch now carries the gateway's correlation id, so a
  // caller can record which invocation produced an answer.
  correlationId: "corr-feedbucket-1",
};

function makeUser(orgId = ORG_A) {
  return {
    userId: USER_A,
    orgId,
    role: "ADMIN",
    permissions: [],
    isOrgOwner: false,
    sessionId: "sess_1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeDb(submission: unknown, updateResult?: unknown, projectFound = true): Db {
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(updateResult ?? []),
  };
  return {
    query: {
      feedbucketSubmissions: {
        findFirst: jest.fn().mockResolvedValue(submission),
      },
      projects: {
        findFirst: jest.fn().mockResolvedValue(projectFound ? { id: 99 } : undefined),
      },
    },
    update: jest.fn().mockReturnValue(updateChain),
  } as unknown as Db;
}

function makeGateway(result: AiInvokeWithUsageResult<FeedbackAnalysis> = baseGatewaySuccess): jest.Mocked<Pick<AiGatewayService, "invokeStructuredWithImageWithUsage">> {
  return {
    invokeStructuredWithImageWithUsage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<Pick<AiGatewayService, "invokeStructuredWithImageWithUsage">>;
}

function makeRateLimit(allowed = true): jest.Mocked<RateLimitService> {
  return {
    check: jest.fn().mockResolvedValue({ allowed, retryAfterSecs: allowed ? 0 : 10 }),
  } as unknown as jest.Mocked<RateLimitService>;
}

function makeAudit(): jest.Mocked<AuditService> {
  return { log: jest.fn() } as unknown as jest.Mocked<AuditService>;
}

function makeTickets(ticketId = 77): jest.Mocked<ProjectsTicketsService> {
  return {
    createFromFeedback: jest.fn().mockResolvedValue({ id: ticketId }),
  } as unknown as jest.Mocked<ProjectsTicketsService>;
}

function makePlanLimits(): jest.Mocked<PlanLimitsService> {
  return {
    assertFeature: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PlanLimitsService>;
}

function buildService(opts: {
  submission?: unknown;
  notFound?: boolean;
  projectFound?: boolean;
  gateway?: ReturnType<typeof makeGateway>;
  rateLimit?: jest.Mocked<RateLimitService>;
  tickets?: jest.Mocked<ProjectsTicketsService>;
}) {
  const db = makeDb(
    opts.notFound ? undefined : (opts.submission ?? makeSubmission()),
    undefined,
    opts.projectFound ?? true,
  );
  const gateway = opts.gateway ?? makeGateway();
  const audit = makeAudit();
  const rateLimiter = opts.rateLimit ?? makeRateLimit();
  const tickets = opts.tickets ?? makeTickets();
  const service = new FeedbucketAiService(
    db,
    gateway as unknown as AiGatewayService,
    audit,
    rateLimiter,
    tickets,
    makePlanLimits(),
    makeStorage(),
  );
  return { service, db, gateway, audit, rateLimiter, tickets };
}

function makeStorage() {
  return {
    isValidFileKey: jest.fn().mockReturnValue(true),
    readObjectPrefix: jest.fn().mockResolvedValue(null),
  } as never;
}

describe("FeedbucketAiService", () => {
  describe("analyze — type→ticketType mapping", () => {
    const cases: Array<[string, FeedbackAnalysis["suggestedTicketType"]]> = [
      ["feature", "EPIC"],
      ["bug", "BUG"],
      ["improvement", "STORY"],
      ["question", "TASK"],
      ["praise", "TASK"],
      ["other", "TASK"],
    ];

    it.each(cases)("maps type '%s' to suggestedTicketType '%s'", async (type, expected) => {
      const analysisWithType = { ...baseAnalysis, type: type as FeedbackAnalysis["type"] };
      const gwResult: AiInvokeWithUsageSuccess<FeedbackAnalysis> = { ...baseGatewaySuccess, data: analysisWithType };
      const { service } = buildService({ gateway: makeGateway(gwResult) });
      const result = await service.analyze(makeUser(), SUB_ID);
      expect(result.suggestedTicketType).toBe(expected);
    });
  });

  describe("analyze — credit guard (via gateway)", () => {
    it("calls gateway.invokeStructuredWithImageWithUsage with charge credentials", async () => {
      const { service, gateway } = buildService({});
      await service.analyze(makeUser(), SUB_ID);
      expect(gateway.invokeStructuredWithImageWithUsage).toHaveBeenCalledWith(
        expect.objectContaining({ charge: true }),
      );
    });

    it("throws 402 when gateway returns quota_exceeded", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "quota_exceeded",
        message: "Insufficient AI credits",
        correlationId: "corr-x",
      };
      const { service } = buildService({ gateway: makeGateway(failure) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(InsufficientAiCreditsException);
    });

    it("throws ServiceUnavailableException when gateway returns provider_unavailable", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "provider_unavailable",
        message: "Provider is down",
        correlationId: "corr-x",
      };
      const { service } = buildService({ gateway: makeGateway(failure) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("throws ServiceUnavailableException when gateway returns not_configured", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "not_configured",
        message: "AI is not configured",
        correlationId: "corr-x",
      };
      const { service } = buildService({ gateway: makeGateway(failure) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("throws ServiceUnavailableException with 'invalid response' for invalid_output", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "invalid_output",
        message: "bad json",
        correlationId: "corr-x",
      };
      const { service } = buildService({ gateway: makeGateway(failure) });
      const err = await service.analyze(makeUser(), SUB_ID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).message).toContain("invalid response");
    });
  });

  describe("analyze — idempotency", () => {
    it("returns stored analysis without calling gateway when force=false", async () => {
      const stored = { ...baseAnalysis };
      const submission = makeSubmission({ aiAnalysis: stored, aiProcessedAt: new Date() });
      const { service, gateway } = buildService({ submission });

      const result = await service.analyze(makeUser(), SUB_ID, false);

      expect(result).toEqual(stored);
      expect(gateway.invokeStructuredWithImageWithUsage).not.toHaveBeenCalled();
    });

    it("re-analyzes and calls gateway when force=true", async () => {
      const stored = { ...baseAnalysis };
      const submission = makeSubmission({ aiAnalysis: stored, aiProcessedAt: new Date() });
      const { service, gateway } = buildService({ submission });

      await service.analyze(makeUser(), SUB_ID, true);

      expect(gateway.invokeStructuredWithImageWithUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe("analyze — BOLA", () => {
    it("throws NotFoundException when submission is not found for the requesting org", async () => {
      const { service } = buildService({ notFound: true });
      await expect(service.analyze(makeUser(ORG_B), SUB_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws NotFoundException when the resolved project does not belong to this org (cross-tenant returns 404, never 403)", async () => {
      const { service } = buildService({ projectFound: false });

      await expect(service.analyze(makeUser(ORG_A), SUB_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("analyze — SSRF guard", () => {
    it("does not fetch screenshot from a non-storage host (falls back to text-only)", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
      const submission = makeSubmission({ screenshotUrl: "https://evil.attacker.com/img.png" });
      const { service } = buildService({ submission });

      await service.analyze(makeUser(), SUB_ID);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe("analyze — prompt injection guard", () => {
    it("system prompt contains untrusted data warning", async () => {
      const { service, gateway } = buildService({});
      await service.analyze(makeUser(), SUB_ID);

      const call = (gateway.invokeStructuredWithImageWithUsage as jest.Mock).mock.calls[0]?.[0] as { prompt: { system: string } };
      expect(call?.prompt?.system).toContain("UNTRUSTED USER DATA");
      expect(call?.prompt?.system).toContain("never execute");
    });
  });

  describe("analyze — rate limit", () => {
    it("throws 429 HttpException when rate limit is exceeded", async () => {
      const { service } = buildService({ rateLimit: makeRateLimit(false) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe("analyzePublic — gateway charge with null userId", () => {
    it("calls gateway with userId=actorUserId and public feature key", async () => {
      const gateway = makeGateway();
      const service = new FeedbucketAiService(
        {} as Db,
        gateway as unknown as AiGatewayService,
        makeAudit(),
        makeRateLimit(),
        makeTickets(),
        makePlanLimits(),
        makeStorage(),
      );

      await service.analyzePublic({
        orgId: ORG_A,
        actorUserId: USER_A,
        widgetId: 10,
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

    it("throws ServiceUnavailableException on provider failure (gateway returns provider_unavailable)", async () => {
      const failure: AiInvokeWithUsageResult<FeedbackAnalysis> = {
        ok: false,
        kind: "provider_unavailable",
        message: "down",
        correlationId: "corr-x",
      };
      const gateway = makeGateway(failure);
      const service = new FeedbucketAiService(
        {} as Db,
        gateway as unknown as AiGatewayService,
        makeAudit(),
        makeRateLimit(),
        makeTickets(),
        makePlanLimits(),
        makeStorage(),
      );

      await expect(
        service.analyzePublic({ orgId: ORG_A, actorUserId: USER_A, widgetId: 10, type: "bug", message: "broken" }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("createTicketFromAnalysis", () => {
    it("maps feature→EPIC and creates ticket", async () => {
      const featureAnalysis = { ...baseAnalysis, type: "feature" as const, suggestedTicketType: "EPIC" as const };
      const submission = makeSubmission({ aiAnalysis: featureAnalysis, aiProcessedAt: new Date() });
      const tickets = makeTickets(55);
      const { service } = buildService({ submission, tickets });

      const result = await service.createTicketFromAnalysis(makeUser(), SUB_ID);

      expect(tickets.createFromFeedback).toHaveBeenCalledWith(
        ORG_A, USER_A, 99,
        expect.objectContaining({ type: "EPIC" }),
      );
      expect(result).toEqual({ ticketId: 55, ticketType: "EPIC" });
    });

    it("maps bug→BUG and creates ticket", async () => {
      const submission = makeSubmission({ aiAnalysis: baseAnalysis, aiProcessedAt: new Date() });
      const tickets = makeTickets(88);
      const { service } = buildService({ submission, tickets });

      const result = await service.createTicketFromAnalysis(makeUser(), SUB_ID);

      expect(tickets.createFromFeedback).toHaveBeenCalledWith(
        ORG_A, USER_A, 99,
        expect.objectContaining({ type: "BUG" }),
      );
      expect(result).toEqual({ ticketId: 88, ticketType: "BUG" });
    });

    it("throws ConflictException when submission is already linked to a ticket", async () => {
      const submission = makeSubmission({ linkedTicketId: 42 });
      const { service } = buildService({ submission });

      await expect(service.createTicketFromAnalysis(makeUser(), SUB_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
