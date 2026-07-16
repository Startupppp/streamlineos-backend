import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmBriefService } from "./services/crm-brief.service";
import { CrmContentService } from "./services/crm-content.service";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { AiJobsService } from "../ai-jobs/ai-jobs.service";
import { DRIZZLE } from "../../db/drizzle.constants";
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

function okResult<T>(data: T): AiInvokeResult<T> {
  return {
    ok: true,
    data,
    model: "test-model",
    latencyMs: 10,
    correlationId: "corr-1",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
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
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      leads: { findFirst: jest.fn().mockResolvedValue(null) },
      clientAccounts: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
}

const FAKE_LEAD = {
  id: 1,
  name: "Jane Smith",
  email: "jane@example.com",
  company: "ACME Corp",
  status: "INTERESTED",
  priority: "HOT",
  score: 75,
  potentialValue: "250000",
  notes: "Very interested in the product",
  followUpDate: null,
  assignedToId: "user-99",
};

const FAKE_DEAL = {
  id: 10,
  name: "Big Enterprise Deal",
  value: "500000",
  stage: "PROPOSAL",
  probability: 55,
  contactPerson: "Bob Jones",
  expectedCloseDate: null,
  notes: "Pending legal review",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-06-01"),
  assignedToId: "user-99",
};

describe("CrmCopilotService Phase 2", () => {
  let mockOrgFeatures: jest.Mocked<Pick<OrgFeaturesService, "getFlags">>;
  let mockGateway: jest.Mocked<Pick<AiGatewayService, "invokeStructured" | "invokeText">>;
  let mockAiJobs: jest.Mocked<Pick<AiJobsService, "enqueue">>;

  async function buildCopilotService(queryResults: unknown[][] = []) {
    mockOrgFeatures = { getFlags: jest.fn() };
    mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    mockAiJobs = { enqueue: jest.fn().mockResolvedValue({ jobId: 42 }) };

    const mockScoring: jest.Mocked<Pick<CrmScoringService, "nextBestAction">> = {
      nextBestAction: jest.fn(),
    };
    const mockContent: jest.Mocked<Pick<CrmContentService, "generateEmail" | "handleObjection">> = {
      generateEmail: jest.fn(),
      handleObjection: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmCopilotService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: CrmScoringService, useValue: mockScoring },
        { provide: CrmContentService, useValue: mockContent },
        { provide: AiJobsService, useValue: mockAiJobs },
      ],
    }).compile();

    return module.get<CrmCopilotService>(CrmCopilotService);
  }

  async function buildScoringService(queryResults: unknown[][] = []) {
    mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmScoringService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();

    return module.get<CrmScoringService>(CrmScoringService);
  }

  async function buildBriefService(queryResults: unknown[][] = []) {
    mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmBriefService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();

    return module.get<CrmBriefService>(CrmBriefService);
  }

  describe.skip("stalePipelineDigest", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      const service = await buildCopilotService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(
        (service as unknown as Record<string, (orgId: string, userId: string) => Promise<unknown>>)
          .stalePipelineDigest("org1", "user1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns empty staleDeals when no active deals exist", async () => {
      const service = await buildCopilotService([[]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);

      const result = await (
        service as unknown as Record<string, (orgId: string, userId: string) => Promise<{ staleDeals: unknown[]; digest: unknown }>>
      ).stalePipelineDigest("org1", "user1");

      expect(result.staleDeals).toEqual([]);
      expect(result.digest).toBeNull();
    });

    it("returns stale deals with evidence when deals have no recent activity", async () => {
      const service = await buildCopilotService([[FAKE_DEAL, { ...FAKE_DEAL, id: 11 }], [], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ digest: "Two deals have gone stale", recommendations: ["Follow up with Bob"] }),
      );

      const result = await (
        service as unknown as Record<string, (orgId: string, userId: string) => Promise<{ staleDeals: Array<{ evidence: unknown[] }>; digest: unknown }>>
      ).stalePipelineDigest("org1", "user1");

      expect(result.staleDeals).toHaveLength(2);
      for (const staleDeal of result.staleDeals) {
        expect(staleDeal.evidence.length).toBeGreaterThan(0);
      }
      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
    });

    it("charges credits and calls gateway with stale pipeline feature key", async () => {
      const service = await buildCopilotService([[FAKE_DEAL], [], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ digest: "One stale deal", recommendations: [] }),
      );

      await (
        service as unknown as Record<string, (orgId: string, userId: string) => Promise<unknown>>
      ).stalePipelineDigest("org1", "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { orgId: "org1", userId: "user1" } }),
      );
    });

    it("returns queued: true and calls enqueue when org has more than 200 deals", async () => {
      const manyDeals = Array.from({ length: 201 }, (_, i) => ({ ...FAKE_DEAL, id: i + 1 }));
      const service = await buildCopilotService([manyDeals]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);

      const result = await (
        service as unknown as Record<string, (orgId: string, userId: string) => Promise<{ queued: boolean }>>
      ).stalePipelineDigest("org1", "user1");

      expect(result.queued).toBe(true);
      expect(mockAiJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org1", type: expect.stringContaining("stale") }),
      );
    });
  });

  describe.skip("dataQualityCopilot", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      const service = await buildCopilotService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(
        (service as unknown as Record<string, (orgId: string, userId: string) => Promise<unknown>>)
          .dataQualityCopilot("org1", "user1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns issues for leads without email", async () => {
      const leadMissingEmail = { ...FAKE_LEAD, email: null, id: 2 };
      const service = await buildCopilotService([[leadMissingEmail]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          issues: [{ leadId: 2, field: "email", type: "missing_field", suggestion: "Collect email during next call" }],
          summary: "1 lead missing email",
          fixableCount: 1,
        }),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, userId: string) => Promise<{ issues: Array<{ type: string }> }>
        >
      ).dataQualityCopilot("org1", "user1");

      expect(result.issues.some((i) => i.type === "missing_field")).toBe(true);
    });

    it("returns empty issues with positive summary when data is clean", async () => {
      const service = await buildCopilotService([[FAKE_LEAD]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "All lead data is complete", fixableCount: 0 }),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, userId: string) => Promise<{ issues: unknown[]; summary: string }>
        >
      ).dataQualityCopilot("org1", "user1");

      expect(result.issues).toEqual([]);
      expect(result.summary).toBeTruthy();
    });

    it("charges crm.data-quality credits via the gateway", async () => {
      const service = await buildCopilotService([[FAKE_LEAD]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "Clean data", fixableCount: 0 }),
      );

      await (
        service as unknown as Record<string, (orgId: string, userId: string) => Promise<unknown>>
      ).dataQualityCopilot("org1", "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ feature: expect.stringContaining("data-quality") }),
      );
    });
  });

  describe.skip("nextBestActionWithEvidence (CrmScoringService)", () => {
    it("returns null when lead not found in org", async () => {
      const service = await buildScoringService([[], []]);

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, leadId: number, userId: string) => Promise<unknown>
        >
      ).nextBestActionWithEvidence("org1", 999, "user1");

      expect(result).toBeNull();
    });

    it("attaches evidence array with activity signal", async () => {
      const lastActivity = { type: "CALL", date: new Date("2024-05-01") };
      const service = await buildScoringService([[FAKE_LEAD], [lastActivity]]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          action: "Schedule follow-up call",
          urgency: "high",
          reasoning: "No contact in 14 days",
          template: "",
          evidence: ["Last CALL activity was 14 days ago"],
          rationale: "Activity gap indicates lead cooling",
        }),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, leadId: number, userId: string) => Promise<{ evidence: unknown[]; rationale: string }>
        >
      ).nextBestActionWithEvidence("org1", 1, "user1");

      expect(result).not.toBeNull();
      expect(result!.evidence.length).toBeGreaterThan(0);
      expect(result!.rationale).toBeDefined();
    });

    it("includes overdue follow-up in evidence when followUpDate is past", async () => {
      const pastFollowUp = { ...FAKE_LEAD, followUpDate: new Date("2020-01-01") };
      const service = await buildScoringService([[pastFollowUp], []]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          action: "Immediate follow-up required",
          urgency: "critical",
          reasoning: "Follow-up is overdue",
          template: "",
          evidence: ["Follow-up date was 2020-01-01 — overdue"],
          rationale: "Overdue follow-up is a strong signal",
        }),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, leadId: number, userId: string) => Promise<{ evidence: string[] }>
        >
      ).nextBestActionWithEvidence("org1", 1, "user1");

      expect(result).not.toBeNull();
      const evidenceText = result!.evidence.join(" ");
      expect(evidenceText.toLowerCase()).toMatch(/overdue|follow.?up/);
    });

    it("charges crm.next-action credits", async () => {
      const service = await buildScoringService([[FAKE_LEAD], []]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          action: "Call lead",
          urgency: "medium",
          reasoning: "Regular check-in",
          template: "",
          evidence: [],
          rationale: "Standard cadence",
        }),
      );

      await (
        service as unknown as Record<
          string,
          (orgId: string, leadId: number, userId?: string) => Promise<unknown>
        >
      ).nextBestActionWithEvidence("org1", 1, "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ feature: "crm.next-action" }),
      );
    });
  });

  describe.skip("leadSummaryWithCitations", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      const service = await buildCopilotService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(
        (service as unknown as Record<string, (orgId: string, leadId: number, userId: string) => Promise<unknown>>)
          .leadSummaryWithCitations("org1", 1, "user1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns citations alongside summary built from lead data", async () => {
      const service = await buildCopilotService([[FAKE_LEAD], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ summary: "Strong lead with high potential", nextBestActions: ["Close the deal"] }),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, leadId: number, userId: string) => Promise<{ citations: unknown[]; summary: string }>
        >
      ).leadSummaryWithCitations("org1", 1, "user1");

      expect(result.summary).toBeTruthy();
      expect(Array.isArray(result.citations)).toBe(true);
      expect(result.citations.length).toBeGreaterThan(0);
    });
  });

  describe.skip("predictDeal (estimateDisclaimer)", () => {
    it("includes estimateDisclaimer in returned result", async () => {
      const service = await buildScoringService([[FAKE_DEAL], [{ count: 3, lastDate: new Date() }]]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          winProbability: 65,
          confidence: "medium",
          reasoning: "Deal is progressing well",
          riskFactors: ["Budget approval pending"],
          positiveSignals: ["Strong stakeholder engagement"],
          recommendedActions: ["Schedule demo"],
        }),
      );

      const result = await service.predictDeal("org1", 10, "user1");

      expect(result).not.toBeNull();
      expect((result as unknown as Record<string, unknown>).estimateDisclaimer).toBeDefined();
      expect(typeof (result as unknown as Record<string, unknown>).estimateDisclaimer).toBe("string");
      expect((result as unknown as Record<string, unknown>).estimateDisclaimer).not.toBe("");
    });

    it("never presents winProbability above 100 or below 0", async () => {
      const service = await buildScoringService([[FAKE_DEAL], [{ count: 0, lastDate: null }]]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          winProbability: 120,
          confidence: "low",
          reasoning: "Extreme optimism from model",
          riskFactors: [],
          positiveSignals: [],
          recommendedActions: [],
        }),
      );

      const result = await service.predictDeal("org1", 10, "user1");

      expect(result).not.toBeNull();
      expect(result!.winProbability).toBeLessThanOrEqual(100);
      expect(result!.winProbability).toBeGreaterThanOrEqual(0);
    });
  });

  describe.skip("meetingFollowUpDraft (CrmBriefService)", () => {
    it("throws NotFoundException when lead attendee is not found", async () => {
      const service = await buildBriefService();
      (service as unknown as { db: ReturnType<typeof makeMockDb> }).db.query.leads.findFirst.mockResolvedValue(undefined);

      await expect(
        (
          service as unknown as Record<
            string,
            (orgId: string, input: { attendeeType: string; attendeeId: number; meetingTitle: string; notes?: string }) => Promise<unknown>
          >
        ).meetingFollowUpDraft("org1", {
          attendeeType: "lead",
          attendeeId: 999,
          meetingTitle: "Q3 Review",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns draft text and attendeeName on success", async () => {
      const service = await buildBriefService();
      const fakeLead = { id: 1, name: "John Doe", email: "john@example.com" };
      (service as unknown as { db: ReturnType<typeof makeMockDb> }).db.query.leads.findFirst.mockResolvedValue(fakeLead);
      mockGateway.invokeText.mockResolvedValue(
        okResult("Dear John, thank you for meeting with us today..."),
      );

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, input: { attendeeType: string; attendeeId: number; meetingTitle: string; notes?: string }) => Promise<{ draft: string; attendeeName: string }>
        >
      ).meetingFollowUpDraft("org1", {
        attendeeType: "lead",
        attendeeId: 1,
        meetingTitle: "Intro Call",
      });

      expect(result.draft).toBe("Dear John, thank you for meeting with us today...");
      expect(result.attendeeName).toBe("John Doe");
    });

    it("never returns an auto-sent result — result has draft property only", async () => {
      const service = await buildBriefService();
      const fakeLead = { id: 1, name: "Alice", email: "alice@example.com" };
      (service as unknown as { db: ReturnType<typeof makeMockDb> }).db.query.leads.findFirst.mockResolvedValue(fakeLead);
      mockGateway.invokeText.mockResolvedValue(okResult("Follow-up text here"));

      const result = await (
        service as unknown as Record<
          string,
          (orgId: string, input: { attendeeType: string; attendeeId: number; meetingTitle: string }) => Promise<Record<string, unknown>>
        >
      ).meetingFollowUpDraft("org1", {
        attendeeType: "lead",
        attendeeId: 1,
        meetingTitle: "Intro",
      });

      expect(result).toHaveProperty("draft");
      expect(result).not.toHaveProperty("sent");
      expect(result).not.toHaveProperty("sendEmail");
    });

    it("charges crm.meeting-follow-up credits via gateway", async () => {
      const service = await buildBriefService();
      const fakeLead = { id: 1, name: "Bob", email: "bob@example.com" };
      (service as unknown as { db: ReturnType<typeof makeMockDb> }).db.query.leads.findFirst.mockResolvedValue(fakeLead);
      mockGateway.invokeText.mockResolvedValue(okResult("Thank you for your time..."));

      await (
        service as unknown as Record<
          string,
          (orgId: string, input: { attendeeType: string; attendeeId: number; meetingTitle: string }) => Promise<unknown>
        >
      ).meetingFollowUpDraft("org1", {
        attendeeType: "lead",
        attendeeId: 1,
        meetingTitle: "Discovery",
      });

      expect(mockGateway.invokeText).toHaveBeenCalledWith(
        expect.objectContaining({ feature: "crm.meeting-follow-up" }),
      );
    });
  });
});
