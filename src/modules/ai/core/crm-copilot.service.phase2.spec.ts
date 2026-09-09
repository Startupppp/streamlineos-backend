import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { CrmCopilotService } from "./services/crm-copilot.service";
import { CrmScoringService } from "./services/crm-scoring.service";
import { CrmContentService } from "./services/crm-content.service";
import { CrmPipelineService } from "./services/crm-pipeline.service";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { OrgFeaturesService } from "./services/org-features.service";
import { AiJobsService } from "../jobs/ai-jobs.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { OrgFeatureFlags } from "./services/org-features.service";
import type { AiInvokeResult } from "./gateway/ai-gateway.types";
import { DealPredictionSchema } from "./dto/output.schemas";

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
    // Every lead read reaches `business_parties` through `lead_party_map`, and
    // the natural-language search hangs the assignee off it with a left join.
    innerJoin: jest.fn().mockImplementation(() => chain),
    leftJoin: jest.fn().mockImplementation(() => chain),
    where: jest.fn().mockImplementation(() => chain),
    // `stalePipelineDigest` aggregates last-activity per deal; without this the
    // chain ends at `.where()` and the aggregate read throws rather than
    // resolving, which reads as a product fault and is a double's omission.
    groupBy: jest.fn().mockImplementation(() => promise),
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
  const db: Record<string, unknown> = {
    execute: jest.fn().mockResolvedValue([]),
    // A transaction double that does not invoke its callback voids every
    // assertion inside it, so this one runs the body against the same double.
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
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
      clientAccounts: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
  return db;
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

/**
 * Every block in this file was `describe.skip` until 2026-09-10, and a skipped
 * block is not coverage — it is a gap that reports as a green suite. The whole
 * file counted as 17 skipped tests in a run of 11,202, which is the quietest
 * possible place for seventeen assertions about an AI surface to stop being
 * made: the feature-flag refusals on `stalePipelineDigest` and
 * `dataQualityCopilot`, the probability clamp, the citation list.
 *
 * Three things had rotted, and all three were invisible because a spec does not
 * typecheck:
 *
 *   1. The database double had no `transaction`, so every method that reaches
 *      `runInTenantTransaction` died in `withTenant`.
 *   2. `stalePipelineDigest` and `dataQualityCopilot` had moved to
 *      `CrmPipelineService`; the tests still called them on `CrmCopilotService`
 *      through an `as unknown as Record<string, ...>` cast, where they hit the
 *      mocked delegate and executed none of the code they named.
 *   3. Several tests asserted on the gateway fixture rather than on the
 *      service. `stalePipelineDigest`, `dataQualityCopilot`,
 *      `nextBestActionWithEvidence` and `predictDeal` all return `result.data`
 *      straight from the model, so "returns issues for leads without email"
 *      and "attaches evidence array" would have passed against a service that
 *      read nothing at all.
 *
 * So the deterministic half is what is asserted now: the refusal, the reads it
 * does and does not make, the credit it does and does not spend, and the text
 * it assembles into the prompt — which is where the signals the service
 * computes actually become observable, since the model's answer is passed
 * through untouched apart from the probability clamp.
 */
describe("CrmCopilotService Phase 2", () => {
  let mockOrgFeatures: jest.Mocked<Pick<OrgFeaturesService, "getFlags">>;
  let mockGateway: jest.Mocked<Pick<AiGatewayService, "invokeStructured" | "invokeText">>;
  let mockAiJobs: jest.Mocked<Pick<AiJobsService, "enqueue">>;

  async function buildCopilotService(queryResults: unknown[][] = []) {
    mockOrgFeatures = { getFlags: jest.fn() };
    mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    mockAiJobs = { enqueue: jest.fn().mockResolvedValue({ jobId: 42 }) };

    const mockScoring: jest.Mocked<Pick<CrmScoringService, "nextBestAction" | "nextBestActionWithEvidence">> = {
      nextBestAction: jest.fn(),
      nextBestActionWithEvidence: jest.fn(),
    };
    const mockContent: jest.Mocked<Pick<CrmContentService, "generateEmail" | "handleObjection">> = {
      generateEmail: jest.fn(),
      handleObjection: jest.fn(),
    };
    const mockPipeline: jest.Mocked<Pick<CrmPipelineService, "stalePipelineDigest" | "dataQualityCopilot">> = {
      stalePipelineDigest: jest.fn(),
      dataQualityCopilot: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmCopilotService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: CrmScoringService, useValue: mockScoring },
        { provide: CrmContentService, useValue: mockContent },
        { provide: CrmPipelineService, useValue: mockPipeline },
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

  /**
   * The pipeline surface moved, and the tests below did not follow it.
   *
   * `stalePipelineDigest` and `dataQualityCopilot` used to live on
   * `CrmCopilotService`; they are now `CrmPipelineService` methods that the
   * copilot forwards to inside `runInTenantTransaction`. The blocks below were
   * still calling them on the copilot through an `as unknown as Record<...>`
   * cast — and because a spec does not typecheck, the cast hid it: the copilot
   * really does expose a method of that name, it just delegates to a mocked
   * pipeline, so `throws ForbiddenException when the flag is off` resolved to
   * `undefined` and the flag check it named was never executed at all.
   */
  async function buildPipelineService(queryResults: unknown[][] = []) {
    mockOrgFeatures = { getFlags: jest.fn() };
    mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    mockAiJobs = { enqueue: jest.fn().mockResolvedValue({ jobId: 42 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmPipelineService,
        { provide: DRIZZLE, useValue: makeMockDb(queryResults) },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: OrgFeaturesService, useValue: mockOrgFeatures },
        { provide: AiJobsService, useValue: mockAiJobs },
      ],
    }).compile();

    return module.get<CrmPipelineService>(CrmPipelineService);
  }

  /** The user half of the single prompt the gateway was handed. */
  function promptUser(): string {
    expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
    const call = mockGateway.invokeStructured.mock.calls[0]![0] as unknown as {
      prompt: { user: string };
    };
    return call.prompt.user;
  }

  /**
   * `stalePipelineDigest` returns a union — a queued job for a big pipeline, a
   * computed digest otherwise — so narrowing it here keeps the tests honest
   * about which branch they meant. Reading `staleDeals` off the union without
   * narrowing is how a test comes to pass against the queued branch by
   * accident.
   */
  function computedDigest(
    result: Awaited<ReturnType<CrmPipelineService["stalePipelineDigest"]>>,
  ) {
    if (!("staleDeals" in result))
      throw new Error("expected a computed digest, got a queued job");
    return result;
  }

  describe("stalePipelineDigest (CrmPipelineService)", () => {
    it("refuses when aiLeadScoring is off, before it reads a single deal", async () => {
      const service = await buildPipelineService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);

      await expect(service.stalePipelineDigest("org1", "user1")).rejects.toThrow(
        ForbiddenException,
      );
      // The order matters: a flag check after the query has already spent the
      // read, and after the gateway call has already spent the credit.
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns nothing and calls no model when the org has no active deals", async () => {
      const service = await buildPipelineService([[{ total: 0 }], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);

      const result = await service.stalePipelineDigest("org1", "user1");

      expect(result).toMatchObject({ staleDeals: [], digest: null });
      // An empty pipeline must not be billed for a digest of nothing.
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("derives days-since-activity and evidence itself rather than asking the model", async () => {
      const service = await buildPipelineService([
        [{ total: 2 }],
        [FAKE_DEAL, { ...FAKE_DEAL, id: 11, name: "Second Deal" }],
        [],
      ]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ digest: "Two deals have gone stale", recommendations: ["Follow up with Bob"] }),
      );

      const result = computedDigest(
        await service.stalePipelineDigest("org1", "user1"),
      );

      expect(result.staleDeals).toHaveLength(2);
      for (const staleDeal of result.staleDeals) {
        // Computed from `updatedAt` because the activity aggregate returned
        // nothing for either deal — the fallback the digest depends on.
        expect(staleDeal.daysSinceActivity).toBeGreaterThan(14);
        expect(staleDeal.evidence).toEqual(
          expect.arrayContaining([
            `${staleDeal.daysSinceActivity} days since last activity`,
            "Stage: PROPOSAL",
          ]),
        );
      }
      // The deals reach the prompt by name, so the digest is about this org's
      // pipeline and not a hallucinated one.
      expect(promptUser()).toContain("Big Enterprise Deal");
      expect(promptUser()).toContain("Second Deal");
    });

    it("charges the stale-pipeline feature against the asking user", async () => {
      const service = await buildPipelineService([[{ total: 1 }], [FAKE_DEAL], []]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ digest: "One stale deal", recommendations: [] }),
      );

      await service.stalePipelineDigest("org1", "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { orgId: "org1", userId: "user1" },
          feature: "crm.stale-pipeline",
          charge: true,
        }),
      );
    });

    it("hands a large pipeline to the job queue instead of doing it in the request", async () => {
      const service = await buildPipelineService([[{ total: 201 }]]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);

      const result = await service.stalePipelineDigest("org1", "user1");

      expect(result).toMatchObject({ queued: true, jobId: 42 });
      expect(mockAiJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org1",
          type: "crm.stale-pipeline",
          // Keyed so a user hammering the button queues one job, not twenty.
          idempotencyKey: expect.stringContaining("org1"),
        }),
      );
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });
  });

  describe("dataQualityCopilot (CrmPipelineService)", () => {
    /** leadsNoEmail, leadsNoOwner, dealsIncomplete, then findDuplicateLeads. */
    function dataQualityReads(
      noEmail: unknown[] = [],
      noOwner: unknown[] = [],
      incompleteDeals: unknown[] = [],
      allLeads: unknown[] = [],
    ): unknown[][] {
      return [noEmail, noOwner, incompleteDeals, allLeads];
    }

    it("refuses when aiLeadScoring is off, before it reads a single lead", async () => {
      const service = await buildPipelineService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);

      await expect(service.dataQualityCopilot("org1", "user1")).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    /**
     * What the service actually produces is the issue list, not the report.
     *
     * `dataQualityCopilot` returns `result.data` — the model's answer — so a
     * test that asserts on the returned issues is asserting on its own gateway
     * fixture and would pass against a service that read nothing at all. The
     * service's own work is the rawIssues summary it puts in the prompt, and
     * that is what these assert.
     */
    it("names a lead with no address as a missing-email issue in the prompt", async () => {
      const service = await buildPipelineService(
        dataQualityReads([{ id: 2, name: "Jane Smith" }]),
      );
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "1 lead missing email", fixableCount: 1 }),
      );

      await service.dataQualityCopilot("org1", "user1");

      expect(promptUser()).toContain(
        `lead "Jane Smith" (id:2): missing_field on field 'email' [high]`,
      );
    });

    it("separates a lead with no owner from a lead with no address", async () => {
      const service = await buildPipelineService(
        dataQualityReads([], [{ id: 3, name: "Unowned Lead" }]),
      );
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "1 unowned lead", fixableCount: 1 }),
      );

      await service.dataQualityCopilot("org1", "user1");

      const prompt = promptUser();
      expect(prompt).toContain(
        `lead "Unowned Lead" (id:3): missing_field on field 'assignedToId' [medium]`,
      );
      // Severity is the whole point of the distinction: an unreachable lead is
      // worse than an unassigned one, and a flat list would say they are equal.
      expect(prompt).not.toContain("on field 'email'");
    });

    it("charges the data-quality feature against the asking user", async () => {
      const service = await buildPipelineService(dataQualityReads());
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "Clean data", fixableCount: 0 }),
      );

      await service.dataQualityCopilot("org1", "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { orgId: "org1", userId: "user1" },
          feature: "crm.data-quality",
          charge: true,
        }),
      );
    });

    /**
     * Recorded, not asserted as desirable: with nothing wrong the service still
     * calls the model, with an empty issue list, and still charges for it.
     * Pinned so the bill is visible in a diff if somebody decides it should
     * short-circuit instead.
     */
    it("still calls and charges the model when there is nothing to report", async () => {
      const service = await buildPipelineService(dataQualityReads());
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ issues: [], summary: "All lead data is complete", fixableCount: 0 }),
      );

      await service.dataQualityCopilot("org1", "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
      expect(promptUser()).not.toMatch(/missing_field|likely_duplicate|incomplete_stage/);
    });
  });

  describe("nextBestActionWithEvidence (CrmScoringService)", () => {
    /** lead, then lastActivity (limit 1), then recentActivities (limit 3). */
    function nextActionReads(
      lead: unknown[],
      lastActivity: unknown[] = [],
      recent: unknown[] = [],
    ): unknown[][] {
      return [lead, lastActivity, recent];
    }

    it("returns null for a lead the org cannot see, without calling the model", async () => {
      const service = await buildScoringService(nextActionReads([]));

      const result = await service.nextBestActionWithEvidence("org1", 999, "user1");

      expect(result).toBeNull();
      // A miss must not be billed, and must not be distinguishable from an
      // absent lead by whether a credit was spent.
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    /**
     * These used to assert on `result.evidence` — which is the gateway
     * fixture's own array, echoed straight back by the service, so they passed
     * over a service that read no lead and computed no signal.
     *
     * The signals the service actually derives (days since contact, AI score,
     * overdue follow-up, status) are assembled into `evidenceSummary` and go
     * into the prompt; the returned `evidence` is the model's. So the prompt is
     * where the deterministic work is observable, and it is what these assert.
     */
    it("puts the signals it computed into the prompt", async () => {
      const service = await buildScoringService(
        nextActionReads(
          [FAKE_LEAD],
          [{ type: "CALL", date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), outcome: null }],
        ),
      );
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

      await service.nextBestActionWithEvidence("org1", 1, "user1");

      const prompt = promptUser();
      expect(prompt).toContain("Days since last contact: 14");
      expect(prompt).toContain("AI lead score: 75");
      expect(prompt).toContain("Status: INTERESTED");
      // Not overdue: FAKE_LEAD has no follow-up date at all.
      expect(prompt).not.toContain("Follow-up overdue");
    });

    it("raises an overdue follow-up as its own signal", async () => {
      const service = await buildScoringService(
        nextActionReads([{ ...FAKE_LEAD, followUpDate: new Date("2020-01-01") }]),
      );
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          action: "Immediate follow-up required",
          urgency: "critical",
          reasoning: "Follow-up is overdue",
          template: "",
          evidence: [],
          rationale: "Overdue follow-up is a strong signal",
        }),
      );

      await service.nextBestActionWithEvidence("org1", 1, "user1");

      expect(promptUser()).toContain("Follow-up overdue: Yes");
    });

    it("charges the next-action feature against the asking user", async () => {
      const service = await buildScoringService(nextActionReads([FAKE_LEAD]));
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

      await service.nextBestActionWithEvidence("org1", 1, "user1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { orgId: "org1", userId: "user1" },
          feature: "crm.next-action",
          charge: true,
        }),
      );
    });
  });

  describe("leadSummaryWithCitations", () => {
    it("throws ForbiddenException when aiLeadScoring is disabled", async () => {
      const service = await buildCopilotService();
      mockOrgFeatures.getFlags.mockResolvedValue(AI_SCORING_OFF);
      await expect(
        service.leadSummaryWithCitations("org1", 1, "user1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns citations alongside summary built from lead data", async () => {
      // Four reads, not two: the citation pass loads the lead and its activity
      // count itself, and then `leadSummary` loads both again. Seeding only the
      // first pair left the summary's lead read empty and the method threw
      // NotFound on a lead the citation pass had just found -- which is the
      // shape of the staleness that had this whole block skipped.
      const service = await buildCopilotService([
        [FAKE_LEAD],
        [{ date: new Date("2024-05-01") }],
        [FAKE_LEAD],
        [],
      ]);
      mockOrgFeatures.getFlags.mockResolvedValue(ALL_FLAGS_ON);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({ summary: "Strong lead with high potential", nextBestActions: ["Close the deal"] }),
      );

      const result = await service.leadSummaryWithCitations("org1", 1, "user1");

      expect(result.summary).toBeTruthy();
      // Citations are the reason this method exists rather than `leadSummary`:
      // a summary of a customer with no stated source is an assertion nobody
      // can check.
      expect(result.citations.length).toBeGreaterThan(0);
      for (const citation of result.citations) {
        expect(citation.id).toBeTruthy();
        expect(citation.title).toBeTruthy();
      }
    });
  });

  describe("predictDeal (CrmScoringService)", () => {
    it("clamps a model that returns an impossible probability", async () => {
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
      expect(result!.winProbability).toBe(100);
    });

    it("clamps a negative probability to zero rather than showing it", async () => {
      const service = await buildScoringService([[FAKE_DEAL], [{ count: 0, lastDate: null }]]);
      mockGateway.invokeStructured.mockResolvedValue(
        okResult({
          winProbability: -30,
          confidence: "low",
          reasoning: "Model went below the floor",
          riskFactors: [],
          positiveSignals: [],
          recommendedActions: [],
        }),
      );

      const result = await service.predictDeal("org1", 10, "user1");

      expect(result!.winProbability).toBe(0);
    });

    /**
     * The disclaimer test that was here asserted `result.estimateDisclaimer` on
     * a gateway fixture that supplied it, so it would have passed with the
     * default deleted from the schema. The guarantee lives in
     * `DealPredictionSchema`: a model answer that omits the field still comes
     * back carrying it, which is what stops a guess being presented as a
     * measurement. That is what is asserted now.
     */
    it("labels every prediction as an estimate even when the model omits it", () => {
      const parsed = DealPredictionSchema.parse({
        winProbability: 65,
        confidence: "medium",
        reasoning: "Deal is progressing well",
        riskFactors: ["Budget approval pending"],
        positiveSignals: ["Strong stakeholder engagement"],
        recommendedActions: ["Schedule demo"],
      });

      expect(typeof parsed.estimateDisclaimer).toBe("string");
      expect(parsed.estimateDisclaimer.trim()).not.toBe("");
      expect(parsed.estimateDisclaimer.toLowerCase()).toContain("estimate");
    });
  });

  /*
    A skipped `meetingFollowUpDraft` block stood here and went with the table.

    Every test in it drove `db.query.leads.findFirst`, and the service stopped
    calling that when `loadLeadContext` moved onto `lead_party_map` joined to
    `business_parties`. That is why the block was skipped: it mocked an API the
    code under test no longer reaches, so it could not be un-skipped without
    being rewritten anyway. Ticket 08 dropped the table the mock was shaped
    like, which settles it.

    That leaves `meetingFollowUpDraft` with no direct test, which is where it
    already was -- a skipped block is not coverage. Recorded here rather than
    quietly dropped, because the gap is real and predates this ticket: the
    method's lead path goes through `loadLeadContext`, and a test worth having
    would mock that seam.
  */
});
