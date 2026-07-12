import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { LlmService } from "./providers/llm.service";
import { AiUsageService } from "./services/ai-usage.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { OrgFeatureFlags } from "./services/org-features.service";

const ALL_FLAGS_ON: OrgFeatureFlags = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

const AI_SCORING_OFF: OrgFeatureFlags = { ...ALL_FLAGS_ON, aiLeadScoring: false };
const AI_EMAIL_OFF: OrgFeatureFlags = { ...ALL_FLAGS_ON, aiEmailDraft: false };

function makeMockDb() {
  const chainMock: Record<string, jest.Mock> & { then?: unknown } = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockResolvedValue(undefined),
    then: jest.fn((resolve: (v: unknown[]) => void) => resolve([])),
  };
  return chainMock;
}

describe("CrmCopilotService", () => {
  let service: CrmCopilotService;
  let mockDb: ReturnType<typeof makeMockDb>;
  let mockOrgFeatures: jest.Mocked<Pick<OrgFeaturesService, "getFlags">>;
  let mockLlm: jest.Mocked<Pick<LlmService, "isConfigured" | "invokeJson" | "invokeText" | "invokeStructured">>;
  let mockUsage: jest.Mocked<Pick<AiUsageService, "track">>;
  let mockScoring: jest.Mocked<Pick<CrmScoringService, "nextBestAction">>;
  let mockContent: jest.Mocked<Pick<CrmContentService, "generateEmail" | "handleObjection">>;

  beforeEach(async () => {
    mockDb = makeMockDb();
    mockOrgFeatures = { getFlags: jest.fn() };
    mockLlm = {
      isConfigured: jest.fn().mockReturnValue(true),
      invokeJson: jest.fn(),
      invokeText: jest.fn(),
      invokeStructured: jest.fn(),
    };
    mockUsage = { track: jest.fn().mockResolvedValue(undefined) };
    mockScoring = { nextBestAction: jest.fn() };
    mockContent = {
      generateEmail: jest.fn(),
      handleObjection: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmCopilotService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: LlmService, useValue: mockLlm },
        { provide: AiUsageService, useValue: mockUsage },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: CrmScoringService, useValue: mockScoring },
        { provide: CrmContentService, useValue: mockContent },
      ],
    }).compile();

    service = module.get<CrmCopilotService>(CrmCopilotService);
  });

  describe("leadSummary", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.leadSummary("org1", 1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when lead is not found in org", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await expect(service.leadSummary("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });

    it("returns summary and nextBestActions on success", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      const fakeLead = { id: 1, name: "John Doe", email: "j@a.com", company: "ACME", status: "NEW", priority: "HOT", score: 80, potentialValue: "500000", notes: null };
      mockDb.limit
        .mockResolvedValueOnce([fakeLead])
        .mockResolvedValueOnce([]);
      mockLlm.invokeJson.mockResolvedValue({ summary: "Strong lead", nextBestActions: ["Call John"] });

      const result = await service.leadSummary("org1", 1, "user1");

      expect(result.summary).toBe("Strong lead");
      expect(result.nextBestActions).toEqual(["Call John"]);
      expect(result.generatedAt).toBeDefined();
      expect(mockUsage.track).toHaveBeenCalledWith(expect.objectContaining({ feature: "crm.lead-summary" }));
    });
  });

  describe("nextBestActionsAcrossPipeline", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.nextBestActionsAcrossPipeline("org1", "user1", 5)).rejects.toThrow(ForbiddenException);
    });

    it("returns empty actions when no leads exist", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockDb.limit.mockResolvedValue([]);

      const result = await service.nextBestActionsAcrossPipeline("org1", "user1", 5);
      expect(result.actions).toEqual([]);
    });
  });

  describe("emailDraftForEntity", () => {
    it("throws ForbiddenException when aiEmailDraft is disabled", async () => {
      mockOrgFeatures.getFlags.mockResolvedValue(AI_EMAIL_OFF);
      await expect(
        service.emailDraftForEntity("org1", "user1", { entityType: "lead", entityId: 1, intent: "follow up", tone: "friendly" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
