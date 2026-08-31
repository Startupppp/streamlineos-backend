import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { Test, type TestingModule } from "@nestjs/testing";
import { SupportAiService } from "./support-ai.service";
import { SupportAiTriageService } from "./support-ai-triage.service";
import { SupportAiTranslationService } from "./support-ai-translation.service";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import { SupportAiReportHelper } from "./support-ai-report.helper";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { EmbeddingsService } from "../../ai/core/providers/embeddings.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { KbAccessService } from "../../kb/core/kb-access.service";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn() },
    supportTicketMessages: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    supportMacros: { findMany: jest.fn().mockResolvedValue([]) },
    supportAiSuggestions: { findFirst: jest.fn() },
    supportTicketDrafts: { findFirst: jest.fn() },
    supportAiSettings: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
};

const mockAiSettings = {
  getSettings: jest.fn().mockResolvedValue({ confidenceThreshold: 0.7 }),
  updateSettings: jest.fn(),
};

const mockReportHelper = {
  getAiReport: jest.fn().mockResolvedValue({
    acceptanceRate: 0, resolutionRate: 0, reopenRate: 0, escalationRate: 0, sourceCoverage: 0, unsupportedRate: 0, csatImpact: null,
  }),
};

const makeGatewayOk = <T>(data: T) => ({
  ok: true as const,
  data,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "corr-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeGatewayFail = (kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output", message = "error") => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-err",
});

const mockGateway = {
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
};

const mockEmbeddings = {
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
  toVectorLiteral: jest.fn((vec: number[]) => `[${vec.join(",")}]`),
};

const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: true }) };

const mockKbAccess = {
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(["space-1"]),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "u1", roleSlugs: [] }),
};

const baseTicket = { id: 42, orgId: "org1", title: "Can't log in", description: "It just spins", category: null, status: "OPEN", priority: "MEDIUM" };

describe("SupportAiService", () => {
  let service: SupportAiService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEmbeddings.isConfigured.mockReturnValue(true);
    mockOrgFeatures.getFlags.mockResolvedValue({ supportAi: true });
    mockDb.query.supportTickets.findFirst.mockResolvedValue(baseTicket);
    mockDb.query.supportTicketMessages.findMany.mockResolvedValue([]);
    mockDb.query.supportMacros.findMany.mockResolvedValue([]);
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

    mockDb.query.supportAiSettings.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportAiService,
        SupportAiTriageService,
        SupportAiTranslationService,
        SupportAiEmbeddingsHelper,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: SupportAiSettingsService, useValue: mockAiSettings },
        { provide: SupportAiReportHelper, useValue: mockReportHelper },
        { provide: KbAccessService, useValue: mockKbAccess },
      ],
    }).compile();
    service = module.get(SupportAiService);
  });

  describe("analyzeTicket", () => {
    it("returns null when the org has disabled support AI", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.analyzeTicket("org1", 42);
      expect(result).toBeNull();
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the ticket doesn't belong to the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.analyzeTicket("org1", 999)).rejects.toThrow(NotFoundException);
    });

    it("persists summary/sentiment/category/priority suggestions from one structured gateway call (no charge)", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        summary: "Customer can't log in.",
        sentiment: "negative",
        category: "account_access",
        suggestedPriority: "HIGH",
        isSpam: false,
        confidence: 0.9,
      }));

      const result = await service.analyzeTicket("org1", 42);

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].charge).toBeUndefined();
      expect(call[0].feature).toBe("support.analysis");
      const insertedTypes = mockDb.values.mock.calls.map((c: [Record<string, unknown>]) => c[0].type);
      expect(insertedTypes).toEqual(expect.arrayContaining(["summary", "sentiment", "category", "priority"]));
      expect(insertedTypes).not.toContain("spam");
    });

    it("persists a spam suggestion when the model flags the ticket as spam", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        summary: "Buy cheap watches now!!!",
        sentiment: "neutral",
        category: null,
        suggestedPriority: "LOW",
        isSpam: true,
        confidence: 0.95,
      }));

      await service.analyzeTicket("org1", 42);
      const insertedTypes = mockDb.values.mock.calls.map((c: [Record<string, unknown>]) => c[0].type);
      expect(insertedTypes).toContain("spam");
      expect(insertedTypes).not.toContain("category");
    });

    it("returns null gracefully when the gateway returns a failure", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayFail("provider_unavailable"));
      const result = await service.analyzeTicket("org1", 42);
      expect(result).toBeNull();
    });
  });

  describe("suggestReply", () => {
    it("returns null when AI is unavailable", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.suggestReply("org1", 42);
      expect(result).toBeNull();
    });

    it("drafts and persists a reply suggestion with credit charge", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Thanks for reaching out — try resetting your password."));

      const result = await service.suggestReply("org1", 42);

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeText.mock.calls;
      expect(call[0].feature).toBe("support.reply");
      expect(call[0].charge).toBe(true);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ type: "reply", payload: expect.objectContaining({ body: "Thanks for reaching out — try resetting your password." }) }),
      );
    });

    it("includes a sources array in the persisted reply payload", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Here is how to reset your password."));
      mockDb.limit.mockResolvedValueOnce([
        { articleId: 5, title: "Password reset guide", slug: "password-reset", similarity: 0.8 },
      ]);

      await service.suggestReply("org1", 42);

      const replyCall = mockDb.values.mock.calls.find((c: [Record<string, unknown>]) => c[0].type === "reply");
      expect((replyCall[0].payload as { sources: unknown[] }).sources).toHaveLength(1);
    });

    it("sets escalated:true in payload when prior confidence is below threshold", async () => {
      mockAiSettings.getSettings.mockResolvedValueOnce({ confidenceThreshold: 0.9 });
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({ confidence: "0.6" });
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Try resetting your password."));

      await service.suggestReply("org1", 42);

      const replyCall = mockDb.values.mock.calls.find((c: [Record<string, unknown>]) => c[0].type === "reply");
      expect((replyCall[0].payload as { escalated: boolean }).escalated).toBe(true);
    });

    it("sets escalated:false when confidence is above threshold", async () => {
      mockAiSettings.getSettings.mockResolvedValueOnce({ confidenceThreshold: 0.5 });
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({ confidence: "0.9" });
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Try resetting your password."));

      await service.suggestReply("org1", 42);

      const replyCall = mockDb.values.mock.calls.find((c: [Record<string, unknown>]) => c[0].type === "reply");
      expect((replyCall[0].payload as { escalated: boolean }).escalated).toBe(false);
    });

    it("throws 402 on quota_exceeded", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));
      await expect(service.suggestReply("org1", 42)).rejects.toThrow(InsufficientAiCreditsException);
    });

    it("throws ServiceUnavailableException on provider_unavailable", async () => {
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayFail("provider_unavailable"));
      await expect(service.suggestReply("org1", 42)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("suggestMacro", () => {
    it("returns null when there are no candidate macros", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([]);
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns null when the model picks no good match", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 1, title: "Reset password", body: "..." }]);
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({ macroId: null, reason: "no good fit", confidence: 0.4 }));
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
    });

    it("returns null if the model hallucinates a macro id not in the candidate list", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 1, title: "Reset password", body: "..." }]);
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({ macroId: 999, reason: "made up", confidence: 0.9 }));
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
    });

    it("persists the picked macro suggestion with credit charge", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 7, title: "Reset password", body: "..." }]);
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({ macroId: 7, reason: "matches password reset", confidence: 0.85 }));

      const result = await service.suggestMacro("org1", "user1", 42);

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].feature).toBe("support.macro");
      expect(call[0].charge).toBe(true);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ type: "macro", payload: { macroId: 7, reason: "matches password reset" } }),
      );
    });
  });

  describe("suggestKbArticles", () => {
    it("returns null when embeddings aren't configured", async () => {
      mockEmbeddings.isConfigured.mockReturnValueOnce(false);
      const result = await service.suggestKbArticles("org1", 42);
      expect(result).toBeNull();
    });

    it("returns null when no article clears the similarity threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([{ articleId: 1, title: "Unrelated", slug: "unrelated", similarity: 0.05 }]);
      const result = await service.suggestKbArticles("org1", 42);
      expect(result).toBeNull();
    });

    it("persists deduped top matches above the similarity threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { articleId: 1, title: "Password reset", slug: "password-reset", similarity: 0.6 },
        { articleId: 1, title: "Password reset", slug: "password-reset", similarity: 0.55 },
        { articleId: 2, title: "Login issues", slug: "login-issues", similarity: 0.3 },
      ]);
      const result = await service.suggestKbArticles("org1", 42);
      expect(result).not.toBeNull();
      const call = mockDb.values.mock.calls.find((c: [Record<string, unknown>]) => c[0].type === "kb_article");
      expect((call[0].payload as { articles: unknown[] }).articles).toHaveLength(2);
    });
  });

  describe("findDuplicates", () => {
    it("returns null when no similar ticket clears the duplicate threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([{ candidateTicketId: 10, title: "Other issue", similarity: 0.5 }]);
      const result = await service.findDuplicates("org1", 42);
      expect(result).toBeNull();
    });

    it("upserts the embedding and persists a duplicate suggestion above threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([{ candidateTicketId: 10, title: "Can't sign in", similarity: 0.92 }]);
      const result = await service.findDuplicates("org1", 42);
      expect(result).not.toBeNull();
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ type: "duplicate", payload: { candidateTicketId: 10, title: "Can't sign in" } }),
      );
    });
  });

  describe("translateMessage", () => {
    it("returns null when AI is unavailable", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.translateMessage("org1", 42, 1, "Spanish");
      expect(result).toBeNull();
    });

    it("throws NotFoundException when the message doesn't belong to the ticket", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.translateMessage("org1", 42, 999, "Spanish")).rejects.toThrow(NotFoundException);
    });

    it("returns the translated text with credit charge", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce({ body: "My login is broken" });
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        translatedText: "Mi inicio de sesión está roto",
        detectedSourceLanguage: "English",
      }));

      const result = await service.translateMessage("org1", 42, 1, "Spanish");

      expect(result).toMatchObject({ translatedText: "Mi inicio de sesión está roto" });
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].feature).toBe("support.translate");
      expect(call[0].charge).toBe(true);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("throws 402 on quota_exceeded", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce({ body: "hello" });
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));
      await expect(service.translateMessage("org1", 42, 1, "French")).rejects.toThrow(InsufficientAiCreditsException);
    });

    it("returns null gracefully when the gateway returns a provider failure", async () => {
      mockDb.query.supportTicketMessages.findFirst.mockResolvedValueOnce({ body: "hello" });
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayFail("provider_unavailable"));
      const result = await service.translateMessage("org1", 42, 1, "French");
      expect(result).toBeNull();
    });
  });

  describe("generateHandoffSummary", () => {
    it("returns null when AI is unavailable", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.generateHandoffSummary("org1", 42);
      expect(result).toBeNull();
    });

    it("persists a handoff_summary suggestion with credit charge", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        summary: "Customer locked out after a password change.",
        keyPoints: ["Password reset link sent", "Customer says link expired"],
        suggestedNextStep: "Manually reset the password and confirm 2FA is still enrolled",
      }));

      const result = await service.generateHandoffSummary("org1", 42);

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].feature).toBe("support.handoff");
      expect(call[0].charge).toBe(true);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "handoff_summary",
          payload: expect.objectContaining({ summary: "Customer locked out after a password change." }),
        }),
      );
    });
  });

  describe("findRootCauseCluster", () => {
    it("returns null when embeddings aren't configured", async () => {
      mockEmbeddings.isConfigured.mockReturnValueOnce(false);
      const result = await service.findRootCauseCluster("org1", 42);
      expect(result).toBeNull();
    });

    it("returns null when no candidate clears the root-cause similarity threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([{ candidateTicketId: 10, title: "Unrelated", similarity: 0.4 }]);
      const result = await service.findRootCauseCluster("org1", 42);
      expect(result).toBeNull();
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("persists a root_cause_cluster suggestion with credit charge when related tickets clear the threshold", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { candidateTicketId: 10, title: "Login keeps timing out", similarity: 0.82 },
        { candidateTicketId: 11, title: "Session expires immediately", similarity: 0.78 },
      ]);
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        rootCause: "Session token expiry misconfiguration",
        summary: "All three tickets describe being logged out immediately after signing in.",
      }));

      const result = await service.findRootCauseCluster("org1", 42);

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].feature).toBe("support.root-cause");
      expect(call[0].charge).toBe(true);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "root_cause_cluster",
          payload: expect.objectContaining({
            relatedTicketIds: [10, 11],
            rootCause: "Session token expiry misconfiguration",
          }),
        }),
      );
    });
  });

  describe("runFullAnalysis", () => {
    it("calls analyzeTicket, findDuplicates, suggestKbArticles — all without charge (background auto)", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        summary: "s", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0.5,
      }));
      mockDb.limit.mockResolvedValue([]);

      await service.runFullAnalysis("org1", 42);

      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
      const [analysisCall] = mockGateway.invokeStructured.mock.calls;
      expect(analysisCall[0].feature).toBe("support.analysis");
      expect(analysisCall[0].charge).toBeUndefined();
    });

    it("swallows errors from sub-calls (fire-and-forget safety)", async () => {
      mockGateway.invokeStructured.mockRejectedValueOnce(new Error("unexpected boom"));
      await expect(service.runFullAnalysis("org1", 42)).resolves.toBeUndefined();
    });
  });

  describe("improveReply", () => {
    it("returns null when AI is unavailable", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.improveReply("org1", 42, "Please help");
      expect(result).toBeNull();
    });

    it("returns improved reply with changes list", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayOk({
        improved: "Thank you for reaching out. Please try resetting your password.",
        changes: ["Added greeting", "Made tone more empathetic"],
      }));

      const result = await service.improveReply("org1", 42, "try resetting password", "user1");

      expect(result).not.toBeNull();
      const [call] = mockGateway.invokeStructured.mock.calls;
      expect(call[0].feature).toBe("support.reply");
      expect(call[0].charge).toBe(true);
      expect(result?.improved).toBe("Thank you for reaching out. Please try resetting your password.");
      expect(result?.changes).toHaveLength(2);
    });

    it("throws 402 when credits are exhausted", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));
      await expect(service.improveReply("org1", 42, "some draft")).rejects.toThrow(InsufficientAiCreditsException);
    });

    it("throws ServiceUnavailableException when provider is down", async () => {
      mockGateway.invokeStructured.mockResolvedValueOnce(makeGatewayFail("provider_unavailable"));
      await expect(service.improveReply("org1", 42, "some draft")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("getAiReport", () => {
    it("delegates to reportHelper and returns the aggregated report shape", async () => {
      mockReportHelper.getAiReport.mockResolvedValueOnce({
        acceptanceRate: 0.75,
        resolutionRate: 0.5,
        reopenRate: 0.1,
        escalationRate: 0.1,
        sourceCoverage: 0.4,
        unsupportedRate: 0.05,
        csatImpact: { aiResolved: 4.2, nonAiResolved: 3.8 },
      });

      const result = await service.getAiReport("org1", { dateFrom: new Date("2026-01-01") });

      expect(result).toMatchObject({ acceptanceRate: 0.75, resolutionRate: 0.5 });
      expect(mockReportHelper.getAiReport).toHaveBeenCalledWith("org1", expect.objectContaining({ dateFrom: expect.any(Date) }));
    });
  });

  describe("resolveSuggestion", () => {
    it("throws NotFoundException for an unknown suggestion", async () => {
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.resolveSuggestion("org1", 1, "user1", { status: "accepted" })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when the suggestion was already resolved", async () => {
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({
        id: 1,
        status: "accepted",
        type: "priority",
        ticketId: 42,
        payload: {},
      });
      await expect(service.resolveSuggestion("org1", 1, "user1", { status: "rejected" })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("applies a priority suggestion to the ticket when accepted", async () => {
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({
        id: 1,
        status: "pending",
        type: "priority",
        ticketId: 42,
        payload: { priority: "URGENT" },
      });
      mockDb.returning.mockResolvedValueOnce([{ id: 1, status: "accepted" }]);

      await service.resolveSuggestion("org1", 1, "user1", { status: "accepted" });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ priority: "URGENT" }));
    });

    it("does not mutate the ticket when rejected", async () => {
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({
        id: 1,
        status: "pending",
        type: "priority",
        ticketId: 42,
        payload: { priority: "URGENT" },
      });
      mockDb.returning.mockResolvedValueOnce([{ id: 1, status: "rejected" }]);

      await service.resolveSuggestion("org1", 1, "user1", { status: "rejected" });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it("links tickets as duplicates when a duplicate suggestion is accepted", async () => {
      mockDb.query.supportAiSuggestions.findFirst.mockResolvedValueOnce({
        id: 2,
        status: "pending",
        type: "duplicate",
        ticketId: 42,
        payload: { candidateTicketId: 10, title: "Can't sign in" },
      });
      mockDb.returning.mockResolvedValueOnce([{ id: 2, status: "accepted" }]);

      await service.resolveSuggestion("org1", 2, "user1", { status: "accepted" });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 42, linkedTicketId: 10, relation: "duplicate" }),
      );
    });
  });
});
