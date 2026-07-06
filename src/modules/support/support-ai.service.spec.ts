import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SupportAiService } from "./support-ai.service";
import { LlmService } from "../ai/providers/llm.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import { AiUsageService } from "../ai/services/ai-usage.service";
import { OrgFeaturesService } from "../ai/services/org-features.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn() },
    supportTicketMessages: { findMany: jest.fn().mockResolvedValue([]) },
    supportMacros: { findMany: jest.fn().mockResolvedValue([]) },
    supportAiSuggestions: { findFirst: jest.fn() },
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
};

const mockLlm = {
  isConfigured: jest.fn().mockReturnValue(true),
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
};

const mockEmbeddings = {
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
  toVectorLiteral: jest.fn((vec: number[]) => `[${vec.join(",")}]`),
};

const mockAiUsage = { track: jest.fn().mockResolvedValue(undefined) };
const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: true }) };

const baseTicket = { id: 42, orgId: "org1", title: "Can't log in", description: "It just spins", category: null };

describe("SupportAiService", () => {
  let service: SupportAiService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLlm.isConfigured.mockReturnValue(true);
    mockEmbeddings.isConfigured.mockReturnValue(true);
    mockOrgFeatures.getFlags.mockResolvedValue({ supportAi: true });
    mockDb.query.supportTickets.findFirst.mockResolvedValue(baseTicket);
    mockDb.query.supportTicketMessages.findMany.mockResolvedValue([]);
    mockDb.query.supportMacros.findMany.mockResolvedValue([]);
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportAiService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: LlmService, useValue: mockLlm },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
        { provide: AiUsageService, useValue: mockAiUsage },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
      ],
    }).compile();
    service = module.get(SupportAiService);
  });

  describe("analyzeTicket", () => {
    it("returns null when the org has disabled support AI", async () => {
      mockOrgFeatures.getFlags.mockResolvedValueOnce({ supportAi: false });
      const result = await service.analyzeTicket("org1", 42);
      expect(result).toBeNull();
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns null when the LLM provider isn't configured", async () => {
      mockLlm.isConfigured.mockReturnValueOnce(false);
      const result = await service.analyzeTicket("org1", 42);
      expect(result).toBeNull();
    });

    it("throws NotFoundException when the ticket doesn't belong to the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.analyzeTicket("org1", 999)).rejects.toThrow(NotFoundException);
    });

    it("persists summary/sentiment/category/priority suggestions from one structured LLM call", async () => {
      mockLlm.invokeStructured.mockResolvedValueOnce({
        summary: "Customer can't log in.",
        sentiment: "negative",
        category: "account_access",
        suggestedPriority: "HIGH",
        isSpam: false,
        confidence: 0.9,
      });

      const result = await service.analyzeTicket("org1", 42);

      expect(result).not.toBeNull();
      expect(mockAiUsage.track).toHaveBeenCalled();
      // summary, sentiment, category, priority persisted; spam not persisted since isSpam is false
      const insertedTypes = mockDb.values.mock.calls.map((call) => call[0].type);
      expect(insertedTypes).toEqual(expect.arrayContaining(["summary", "sentiment", "category", "priority"]));
      expect(insertedTypes).not.toContain("spam");
    });

    it("persists a spam suggestion when the model flags the ticket as spam", async () => {
      mockLlm.invokeStructured.mockResolvedValueOnce({
        summary: "Buy cheap watches now!!!",
        sentiment: "neutral",
        category: null,
        suggestedPriority: "LOW",
        isSpam: true,
        confidence: 0.95,
      });

      await service.analyzeTicket("org1", 42);
      const insertedTypes = mockDb.values.mock.calls.map((call) => call[0].type);
      expect(insertedTypes).toContain("spam");
      expect(insertedTypes).not.toContain("category");
    });

    it("returns null gracefully when the LLM call throws", async () => {
      mockLlm.invokeStructured.mockRejectedValueOnce(new Error("provider timeout"));
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

    it("drafts and persists a reply suggestion", async () => {
      mockLlm.invokeText.mockResolvedValueOnce("Thanks for reaching out — try resetting your password.");
      const result = await service.suggestReply("org1", 42);
      expect(result).not.toBeNull();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ type: "reply", payload: { body: "Thanks for reaching out — try resetting your password." } }),
      );
    });
  });

  describe("suggestMacro", () => {
    it("returns null when there are no candidate macros", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([]);
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns null when the model picks no good match", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 1, title: "Reset password", body: "..." }]);
      mockLlm.invokeStructured.mockResolvedValueOnce({ macroId: null, reason: "no good fit", confidence: 0.4 });
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
    });

    it("returns null if the model hallucinates a macro id not in the candidate list", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 1, title: "Reset password", body: "..." }]);
      mockLlm.invokeStructured.mockResolvedValueOnce({ macroId: 999, reason: "made up", confidence: 0.9 });
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).toBeNull();
    });

    it("persists the picked macro suggestion when it's a valid candidate", async () => {
      mockDb.query.supportMacros.findMany.mockResolvedValueOnce([{ id: 7, title: "Reset password", body: "..." }]);
      mockLlm.invokeStructured.mockResolvedValueOnce({ macroId: 7, reason: "matches password reset", confidence: 0.85 });
      const result = await service.suggestMacro("org1", "user1", 42);
      expect(result).not.toBeNull();
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
      const call = mockDb.values.mock.calls.find((c) => c[0].type === "kb_article");
      expect(call[0].payload.articles).toHaveLength(2);
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

      // only the final status-update call to `update`, not an earlier ticket-priority update
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
