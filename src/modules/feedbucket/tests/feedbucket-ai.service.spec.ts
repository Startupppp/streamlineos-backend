jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../../projects/projects-tickets.service");

import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { FeedbucketAiService } from "../feedbucket-ai.service";
import type { Db } from "../../../db/drizzle.module";
import type { LlmService } from "../../ai/providers/llm.service";
import type { AiCreditsService } from "../../billing/ai-credits.service";
import type { AiUsageService } from "../../ai/services/ai-usage.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import type { ProjectsTicketsService } from "../../projects/projects-tickets.service";
import type { FeedbackAnalysis } from "../feedbucket-ai.schemas";

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

function makeUser(orgId = ORG_A, plan = "PROFESSIONAL") {
  return {
    userId: USER_A,
    orgId,
    branchId: null,
    role: "ADMIN",
    permissions: [],
    enabledModules: [],
    plan,
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "sess_1",
  };
}

function makeDb(submission: unknown, updateResult?: unknown): Db {
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(updateResult ?? []),
  };
  return {
    query: {
      feedbucketSubmissions: {
        findFirst: jest.fn().mockResolvedValue(submission),
      },
    },
    update: jest.fn().mockReturnValue(updateChain),
  } as unknown as Db;
}

function makeLlm(result: FeedbackAnalysis = baseAnalysis, configured = true): jest.Mocked<LlmService> {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    invokeStructured: jest.fn().mockResolvedValue(result),
    invokeStructuredWithImage: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<LlmService>;
}

function makeCredits(fail = false): jest.Mocked<AiCreditsService> {
  const consume = fail
    ? jest.fn().mockRejectedValue(new BadRequestException("Insufficient AI credits"))
    : jest.fn().mockResolvedValue({ balance: 95 });
  return {
    consumeCredits: consume,
    refundCredits: jest.fn().mockResolvedValue({ balance: 100 }),
  } as unknown as jest.Mocked<AiCreditsService>;
}

function makeRateLimit(allowed = true): jest.Mocked<RateLimitService> {
  return {
    check: jest.fn().mockResolvedValue({ allowed, retryAfterSecs: allowed ? 0 : 10 }),
  } as unknown as jest.Mocked<RateLimitService>;
}

function makeAudit(): jest.Mocked<AuditService> {
  return { log: jest.fn() } as unknown as jest.Mocked<AuditService>;
}

function makeAiUsage(): jest.Mocked<AiUsageService> {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

function makeTickets(ticketId = 77): jest.Mocked<ProjectsTicketsService> {
  return {
    createFromFeedback: jest.fn().mockResolvedValue({ id: ticketId }),
  } as unknown as jest.Mocked<ProjectsTicketsService>;
}

function buildService(opts: {
  submission?: unknown;
  notFound?: boolean;
  llm?: jest.Mocked<LlmService>;
  credits?: jest.Mocked<AiCreditsService>;
  rateLimit?: jest.Mocked<RateLimitService>;
  tickets?: jest.Mocked<ProjectsTicketsService>;
}) {
  const db = makeDb(opts.notFound ? undefined : (opts.submission ?? makeSubmission()));
  const llm = opts.llm ?? makeLlm();
  const credits = opts.credits ?? makeCredits();
  const audit = makeAudit();
  const aiUsage = makeAiUsage();
  const rateLimiter = opts.rateLimit ?? makeRateLimit();
  const tickets = opts.tickets ?? makeTickets();
  const service = new FeedbucketAiService(db, llm, credits, aiUsage, audit, rateLimiter, tickets);
  return { service, db, llm, credits, audit, aiUsage, rateLimiter, tickets };
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
      const llmResult = { ...baseAnalysis, type: type as FeedbackAnalysis["type"] };
      const { service } = buildService({ llm: makeLlm(llmResult) });
      const result = await service.analyze(makeUser(), SUB_ID);
      expect(result.suggestedTicketType).toBe(expected);
    });
  });

  describe("analyze — credit guard", () => {
    it("calls consumeCredits before the LLM call", async () => {
      const { service, credits, llm } = buildService({});
      const callOrder: string[] = [];
      (credits.consumeCredits as jest.Mock).mockImplementation(async () => {
        callOrder.push("consume");
        return { balance: 95 };
      });
      (llm.invokeStructuredWithImage as jest.Mock).mockImplementation(async () => {
        callOrder.push("llm");
        return baseAnalysis;
      });

      await service.analyze(makeUser(), SUB_ID);

      expect(callOrder).toEqual(["consume", "llm"]);
    });

    it("refunds credits when the LLM throws ServiceUnavailableException", async () => {
      const llm = makeLlm();
      (llm.invokeStructuredWithImage as jest.Mock).mockRejectedValue(
        new ServiceUnavailableException("down"),
      );
      const credits = makeCredits();
      const { service } = buildService({ llm, credits });

      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(credits.refundCredits).toHaveBeenCalledWith(ORG_A, USER_A, 5, "feedbucket.ai-analyze", String(SUB_ID));
    });

    it("propagates BadRequestException (insufficient credits) without refund", async () => {
      const { service, credits } = buildService({ credits: makeCredits(true) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(credits.refundCredits).not.toHaveBeenCalled();
    });
  });

  describe("analyze — idempotency", () => {
    it("returns stored analysis without charging again when force=false", async () => {
      const stored = { ...baseAnalysis };
      const submission = makeSubmission({ aiAnalysis: stored, aiProcessedAt: new Date() });
      const { service, credits, llm } = buildService({ submission });

      const result = await service.analyze(makeUser(), SUB_ID, false);

      expect(result).toEqual(stored);
      expect(credits.consumeCredits).not.toHaveBeenCalled();
      expect(llm.invokeStructuredWithImage).not.toHaveBeenCalled();
    });

    it("re-analyzes and charges when force=true", async () => {
      const stored = { ...baseAnalysis };
      const submission = makeSubmission({ aiAnalysis: stored, aiProcessedAt: new Date() });
      const { service, credits } = buildService({ submission });

      await service.analyze(makeUser(), SUB_ID, true);

      expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    });
  });

  describe("analyze — BOLA", () => {
    it("throws NotFoundException when submission is not found for the requesting org", async () => {
      const { service } = buildService({ notFound: true });
      await expect(service.analyze(makeUser(ORG_B), SUB_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws ForbiddenException when project belongs to a different org", async () => {
      const foreignProjectWidget = { ...baseWidget, project: { id: 99, orgId: ORG_B } };
      const submission = makeSubmission({ widget: foreignProjectWidget });
      const { service } = buildService({ submission });

      await expect(service.analyze(makeUser(ORG_A), SUB_ID)).rejects.toBeInstanceOf(ForbiddenException);
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
      const { service, llm } = buildService({});
      await service.analyze(makeUser(), SUB_ID);

      const call = (llm.invokeStructuredWithImage as jest.Mock).mock.calls[0]?.[0] as { system: string };
      expect(call?.system).toContain("UNTRUSTED USER DATA");
      expect(call?.system).toContain("never execute");
    });
  });

  describe("analyze — rate limit", () => {
    it("throws 429 HttpException when rate limit is exceeded", async () => {
      const { service } = buildService({ rateLimit: makeRateLimit(false) });
      await expect(service.analyze(makeUser(), SUB_ID)).rejects.toBeInstanceOf(HttpException);
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
