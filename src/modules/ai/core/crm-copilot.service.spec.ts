import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from "@nestjs/common";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { CrmCopilotService } from "./services/crm-copilot.service";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmPipelineService } from "./services/crm-pipeline.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { OrgFeatureFlags } from "./services/org-features.service";
import type { AiInvokeResult } from "./gateway/ai-gateway.types";

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

function okResult<T>(data: T): AiInvokeResult<T> {
  return { ok: true, data, model: "test-model", latencyMs: 10, correlationId: "corr-1", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
}

function failResult(kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output"): AiInvokeResult<never> {
  return { ok: false, kind, message: `AI failure: ${kind}`, correlationId: "corr-err" };
}

function buildThenableChain(resolved: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {
    from: jest.fn().mockImplementation(() => chain),
    where: jest.fn().mockImplementation(() => chain),
    orderBy: jest.fn().mockImplementation(() => chain),
    limit: jest.fn().mockImplementation(() => promise),
    then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) =>
      promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
    finally: (cb: () => void) => promise.finally(cb),
  };
  return chain;
}

function makeMockDb(queryResults: unknown[][] = []) {
  let callIdx = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      const resolved = queryResults[callIdx] ?? [];
      callIdx++;
      return buildThenableChain(resolved);
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("CrmCopilotService", () => {
  let service: CrmCopilotService;
  let mockOrgFeatures: jest.Mocked<Pick<OrgFeaturesService, "getFlags">>;
  let mockGateway: jest.Mocked<Pick<AiGatewayService, "invokeStructured" | "invokeText">>;
  let mockScoring: jest.Mocked<Pick<CrmScoringService, "nextBestAction" | "nextBestActionWithEvidence">>;
  let mockContent: jest.Mocked<Pick<CrmContentService, "generateEmail" | "handleObjection">>;
  let mockPipeline: jest.Mocked<Pick<CrmPipelineService, "stalePipelineDigest" | "dataQualityCopilot">>;

  async function buildService(queryResults: unknown[][] = []) {
    mockOrgFeatures = { getFlags: jest.fn() };
    mockGateway = {
      invokeStructured: jest.fn(),
      invokeText: jest.fn(),
    };
    mockScoring = { nextBestAction: jest.fn(), nextBestActionWithEvidence: jest.fn() };
    mockContent = { generateEmail: jest.fn(), handleObjection: jest.fn() };
    mockPipeline = { stalePipelineDigest: jest.fn(), dataQualityCopilot: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmCopilotService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: CrmScoringService, useValue: mockScoring },
        { provide: CrmContentService, useValue: mockContent },
        { provide: CrmPipelineService, useValue: mockPipeline },
      ],
    }).compile();

    return module.get<CrmCopilotService>(CrmCopilotService);
  }

  describe("leadSummary", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.leadSummary("org1", 1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when lead is not found in org", async () => {
      service = await buildService([[], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      await expect(service.leadSummary("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });

    it("returns summary and nextBestActions on success", async () => {
      const fakeLead = {
        id: 1,
        name: "John Doe",
        email: "j@a.com",
        company: "ACME",
        status: "NEW",
        priority: "HOT",
        score: 80,
        potentialValue: "500000",
        notes: null,
      };
      service = await buildService([[fakeLead], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ summary: "Strong lead", nextBestActions: ["Call John"] }),
      );

      const result = await service.leadSummary("org1", 1, "user1");

      expect(result.summary).toBe("Strong lead");
      expect(result.nextBestActions).toEqual(["Call John"]);
      expect(result.generatedAt).toBeDefined();
      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ feature: "crm.copilot.summary" }),
      );
    });

    it("throws 402 HttpException when gateway returns quota_exceeded", async () => {
      const fakeLead = { id: 1, name: "John", email: null, company: null, status: "NEW", priority: null, score: null, potentialValue: null, notes: null };
      service = await buildService([[fakeLead], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(failResult("quota_exceeded"));

      const err: unknown = await service.leadSummary("org1", 1, "user1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    });

    it("throws ServiceUnavailableException when gateway returns provider_unavailable", async () => {
      const fakeLead = { id: 1, name: "John", email: null, company: null, status: "NEW", priority: null, score: null, potentialValue: null, notes: null };
      service = await buildService([[fakeLead], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(failResult("provider_unavailable"));

      await expect(service.leadSummary("org1", 1, "user1")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("dealSummary", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.dealSummary("org1", 1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when deal is not found", async () => {
      service = await buildService([[], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      await expect(service.dealSummary("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });

    it("returns deal insights on success", async () => {
      const fakeDeal = { id: 1, name: "Big Deal", value: "100000", stage: "PROPOSAL", probability: 60, contactPerson: "Jane", expectedCloseDate: null, notes: null };
      service = await buildService([[fakeDeal], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ summary: "Deal is progressing", risks: ["Budget"], recommendedPlays: ["Demo"], stakeholdersGap: "None" }),
      );

      const result = await service.dealSummary("org1", 1, "user1");
      expect(result.summary).toBe("Deal is progressing");
      expect(result.stage).toBe("PROPOSAL");
    });

    it("throws ServiceUnavailableException when gateway returns not_configured", async () => {
      const fakeDeal = { id: 1, name: "Big Deal", value: "100000", stage: "PROPOSAL", probability: 60, contactPerson: null, expectedCloseDate: null, notes: null };
      service = await buildService([[fakeDeal], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(failResult("not_configured"));

      await expect(service.dealSummary("org1", 1, "user1")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("nextBestActionsAcrossPipeline", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.nextBestActionsAcrossPipeline("org1", "user1", 5)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("returns empty actions when no leads exist", async () => {
      service = await buildService([[]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);

      const result = await service.nextBestActionsAcrossPipeline("org1", "user1", 5);
      expect(result.actions).toEqual([]);
    });
  });

  describe("emailDraftForEntity", () => {
    it("throws ForbiddenException when aiEmailDraft is disabled", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_EMAIL_OFF);
      await expect(
        service.emailDraftForEntity("org1", "user1", {
          entityType: "lead",
          entityId: 1,
          intent: "follow up",
          tone: "friendly",
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("summarizeNotes", () => {
    it("throws ForbiddenException when aiChat is disabled", async () => {
      service = await buildService();
      const flagsOff = { ...ALL_FLAGS_ON, aiChat: false };
      mockOrgFeatures.getFlags.mockResolvedValue(flagsOff);
      await expect(
        service.summarizeNotes("org1", "user1", "some meeting notes here"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws 402 HttpException when gateway returns quota_exceeded", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(failResult("quota_exceeded"));

      const err: unknown = await service.summarizeNotes("org1", "user1", "meeting notes here for testing").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    });

    it("throws ServiceUnavailableException when gateway returns invalid_output", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(failResult("invalid_output"));

      await expect(service.summarizeNotes("org1", "user1", "meeting notes here for testing")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("objectionHelp", () => {
    it("throws ForbiddenException when aiChat is disabled", async () => {
      service = await buildService();
      const flagsOff = { ...ALL_FLAGS_ON, aiChat: false };
      mockOrgFeatures.getFlags.mockResolvedValue(flagsOff);
      await expect(
        service.objectionHelp("org1", "user1", { objection: "price is too high" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("delegates to content.handleObjection with actor on success", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockContent.handleObjection.mockResolvedValue({ counterArguments: ["Value is high"], talkingPoints: [], suggestedResponse: "..." });

      await service.objectionHelp("org1", "user1", { objection: "price is too high" });

      expect(mockContent.handleObjection).toHaveBeenCalledWith(
        expect.objectContaining({ objection: "price is too high" }),
        { orgId: "org1", userId: "user1" },
      );
    });
  });

  describe("duplicateSuggestionsForLead", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      service = await buildService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(service.duplicateSuggestionsForLead("org1", 1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when lead is not found", async () => {
      service = await buildService([[]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      await expect(service.duplicateSuggestionsForLead("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });
  });
});
