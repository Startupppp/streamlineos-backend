import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { Test } from "@nestjs/testing";
import { SupportKbGapService } from "./support-kb-gap.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { KbArticlesService } from "../../kb/help-centre/kb-articles.service";
import { KbEventsService } from "../../kb/core/kb-events.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const makeGatewayOk = <T>(data: T) => ({
  ok: true as const,
  data,
  aiUsage: {
    model: "claude-3-5-haiku",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    credits: 1,
    costUsd: 0.001,
  },
});

const makeGatewayFail = (
  kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output",
  message = "error",
) => ({ ok: false as const, kind, message, correlationId: "corr-err" });

const baseGap = {
  id: 1,
  orgId: "org1",
  clusterKey: "cluster:10",
  representativeQuestion: "How do I reset my password?",
  ticketCount: 5,
  sampleTicketIds: [10, 11, 12],
  status: SupportKnowledgeGapStatus.OPEN,
  proposedArticleId: null,
  draftedBy: null,
  reviewedBy: null,
  evidence: { searchQueries: [], relatedTicketIds: [10, 11, 12] },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeDb = () => ({
  query: {
    supportKnowledgeGaps: { findFirst: jest.fn() },
    kbSpaces: { findFirst: jest.fn() },
  },
  execute: jest.fn().mockResolvedValue([]),
  select: jest.fn().mockReturnThis(),
  selectDistinct: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([
    { ...baseGap, status: SupportKnowledgeGapStatus.ROUTED, proposedArticleId: 99, draftedBy: "user1" },
  ]),
});

const mockGateway = { invokeStructuredWithUsage: jest.fn() };
const mockKbArticles = { create: jest.fn() };
const mockKbEvents = { record: jest.fn().mockResolvedValue(undefined) };
const mockNotifications = { emit: jest.fn().mockResolvedValue({ notified: 1 }) };

async function makeService(db: ReturnType<typeof makeDb>) {
  const module = await Test.createTestingModule({
    providers: [
      SupportKbGapService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiGatewayService, useValue: mockGateway },
      { provide: KbArticlesService, useValue: mockKbArticles },
      { provide: KbEventsService, useValue: mockKbEvents },
      { provide: NotificationDispatchService, useValue: mockNotifications },
    ],
  }).compile();

  return module.get(SupportKbGapService);
}

describe("SupportKbGapService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("detectGaps", () => {
    it("should return created=0 updated=0 when no clusters and no search gaps", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([]);
      db.limit.mockResolvedValue([]);
      const service = await makeService(db);
      const result = await service.detectGaps("org1");
      expect(result).toEqual({ created: 0, updated: 0 });
    });

    it("should create new gap rows for ticket clusters", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([
        {
          representative_ticket_id: 10,
          cluster_ids: [11, 12],
          representative_question: "Login fails",
        },
      ]);
      db.limit.mockResolvedValue([]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(null);
      db.returning.mockResolvedValue([]);

      const service = await makeService(db);
      const result = await service.detectGaps("org1");

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("should return created=2 when two distinct clusters have no existing gap rows", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([
        { representative_ticket_id: 1, cluster_ids: [2], representative_question: "Q1" },
        { representative_ticket_id: 3, cluster_ids: [4], representative_question: "Q2" },
      ]);
      db.limit.mockResolvedValue([]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(null);
      db.returning.mockResolvedValue([]);

      const service = await makeService(db);
      const result = await service.detectGaps("org1");

      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
    });

    it("should update an existing OPEN gap idempotently on second call", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([
        {
          representative_ticket_id: 10,
          cluster_ids: [11],
          representative_question: "Login fails",
        },
      ]);
      db.limit.mockResolvedValue([]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue({
        id: 5,
        status: SupportKnowledgeGapStatus.OPEN,
      });
      db.returning.mockResolvedValue([]);

      const service = await makeService(db);
      const result = await service.detectGaps("org1");

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
    });

    it("should skip a gap that is already DISMISSED", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([
        { representative_ticket_id: 10, cluster_ids: [11], representative_question: "Q" },
      ]);
      db.limit.mockResolvedValue([]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue({
        id: 5,
        status: SupportKnowledgeGapStatus.DISMISSED,
      });

      const service = await makeService(db);
      const result = await service.detectGaps("org1");

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
    });

    it("should incorporate search_no_results events and create gap rows with OPEN status", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([]);
      db.limit
        .mockResolvedValueOnce([
          { query: "how to export data", count: 8, lastOccurredAt: new Date() },
        ]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(null);
      db.returning.mockResolvedValue([]);

      const service = await makeService(db);
      const result = await service.detectGaps("org1");

      expect(result.created).toBe(1);
      expect(db.insert).toHaveBeenCalled();
      const insertValuesCall = db.values.mock.calls[0] as [
        {
          orgId: string;
          clusterKey: string;
          status: string;
          evidence: { searchQueries: Array<{ query: string; count: number }> };
        },
      ];
      expect(insertValuesCall[0].status).toBe(SupportKnowledgeGapStatus.OPEN);
      expect(insertValuesCall[0].evidence.searchQueries[0]).toMatchObject({
        query: "how to export data",
        count: 8,
      });
    });

    it("should create gap rows with evidence containing searchQueries for search_no_results", async () => {
      const db = makeDb();
      db.execute.mockResolvedValue([]);
      db.limit.mockResolvedValueOnce([
        { query: "invoice download", count: 5, lastOccurredAt: new Date() },
      ]);
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(null);
      db.returning.mockResolvedValue([]);

      const service = await makeService(db);
      await service.detectGaps("org1");

      const insertValuesCall = db.values.mock.calls[0] as [
        { clusterKey: string; evidence: { searchQueries: Array<{ query: string }> } },
      ];
      expect(insertValuesCall[0].clusterKey).toBe("search:invoice download");
      expect(insertValuesCall[0].evidence.searchQueries).toHaveLength(1);
    });
  });

  describe("proposeDraft", () => {
    it("should throw NotFoundException when gap not found", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(null);
      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });

    it("should throw BadRequestException when gap is DISMISSED", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue({
        ...baseGap,
        status: SupportKnowledgeGapStatus.DISMISSED,
      });
      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 1, "user1")).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when gap is PUBLISHED", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue({
        ...baseGap,
        status: SupportKnowledgeGapStatus.PUBLISHED,
      });
      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 1, "user1")).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when no KB space found", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue(null);
      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 1, "user1")).rejects.toThrow(BadRequestException);
    });

    it("should create an UNPUBLISHED draft article and route the gap", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 7 });
      db.limit.mockResolvedValueOnce([{ userId: "kbowner1" }]);
      db.returning.mockResolvedValue([
        { ...baseGap, status: SupportKnowledgeGapStatus.ROUTED, proposedArticleId: 99, draftedBy: "user1" },
      ]);

      mockGateway.invokeStructuredWithUsage.mockResolvedValue(
        makeGatewayOk({ title: "How to reset your password", body: "## Steps\n1. Click forgot password" }),
      );
      mockKbArticles.create.mockResolvedValue({ id: 99, title: "How to reset your password" });

      const service = await makeService(db);
      const result = await service.proposeDraft("org1", 1, "user1");

      expect(mockKbArticles.create).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org1", userId: "user1" }),
        expect.objectContaining({
          status: "draft",
          visibility: "internal",
          spaceId: 7,
        }),
      );
      expect(mockKbEvents.record).toHaveBeenCalledWith(
        "org1",
        "ticket_deflected",
        expect.objectContaining({
          actorId: "user1",
          articleId: 99,
          metadata: expect.objectContaining({ feature: "kb_gap_draft", gapId: 1 }),
        }),
      );
      expect(result.status).toBe(SupportKnowledgeGapStatus.ROUTED);
      expect(result.proposedArticleId).toBe(99);
    });

    it("should never create a PUBLISHED article", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 7 });
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([{ ...baseGap, status: SupportKnowledgeGapStatus.ROUTED }]);
      mockGateway.invokeStructuredWithUsage.mockResolvedValue(
        makeGatewayOk({ title: "T", body: "B" }),
      );
      mockKbArticles.create.mockResolvedValue({ id: 50, title: "T" });

      const service = await makeService(db);
      await service.proposeDraft("org1", 1, "user1");

      const createCall = mockKbArticles.create.mock.calls[0] as [unknown, { status: string }];
      expect(createCall[1].status).toBe("draft");
      expect(createCall[1].status).not.toBe("published");
    });

    it("should pass the actor user context to kbArticles.create for permission enforcement", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 3 });
      db.limit.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([{ ...baseGap, status: SupportKnowledgeGapStatus.ROUTED }]);
      mockGateway.invokeStructuredWithUsage.mockResolvedValue(makeGatewayOk({ title: "T", body: "B" }));
      mockKbArticles.create.mockResolvedValue({ id: 77, title: "T" });

      const service = await makeService(db);
      const actorCtx = {
        userId: "actor-123",
        orgId: "org1",
        role: "support_agent",
        permissions: ["kb:articles:create"],
        isOrgOwner: false,
        sessionId: "sess-abc",
        tokenScopes: null,
        principal: humanSessionPrincipal(1, false),
      };
      await service.proposeDraft("org1", 1, "actor-123", actorCtx);

      expect(mockKbArticles.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "actor-123", orgId: "org1" }),
        expect.anything(),
      );
    });

    it("should emit a notification to KB owners after routing", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 7 });
      db.limit.mockResolvedValueOnce([{ userId: "owner1" }, { userId: "owner2" }]);
      db.returning.mockResolvedValue([
        { ...baseGap, status: SupportKnowledgeGapStatus.ROUTED, proposedArticleId: 99 },
      ]);
      mockGateway.invokeStructuredWithUsage.mockResolvedValue(
        makeGatewayOk({ title: "T", body: "B" }),
      );
      mockKbArticles.create.mockResolvedValue({ id: 99, title: "T" });

      const service = await makeService(db);
      await service.proposeDraft("org1", 1, "user1");

      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "support.kb.gap.routed",
          orgId: "org1",
          targetUserIds: ["owner1", "owner2"],
          entityType: "kb_gap",
        }),
      );
    });

    it("should throw 402 when AI gateway returns quota_exceeded", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 7 });
      db.limit.mockResolvedValueOnce([]);
      mockGateway.invokeStructuredWithUsage.mockResolvedValue(makeGatewayFail("quota_exceeded", "Out of credits"));

      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 1, "user1")).rejects.toThrow(
        InsufficientAiCreditsException,
      );
    });

    it("should throw BadRequestException when AI gateway returns provider_unavailable", async () => {
      const db = makeDb();
      db.query.supportKnowledgeGaps.findFirst.mockResolvedValue(baseGap);
      db.query.kbSpaces.findFirst.mockResolvedValue({ id: 7 });
      db.limit.mockResolvedValueOnce([]);
      mockGateway.invokeStructuredWithUsage.mockResolvedValue(makeGatewayFail("provider_unavailable", "Service down"));

      const service = await makeService(db);
      await expect(service.proposeDraft("org1", 1, "user1")).rejects.toThrow(BadRequestException);
    });
  });

  describe("dismissGap", () => {
    it("should throw NotFoundException when gap not found", async () => {
      const db = makeDb();
      db.returning.mockResolvedValue([]);
      const service = await makeService(db);
      await expect(service.dismissGap("org1", 999)).rejects.toThrow(NotFoundException);
    });

    it("should set status to DISMISSED", async () => {
      const db = makeDb();
      db.returning.mockResolvedValue([{ ...baseGap, status: SupportKnowledgeGapStatus.DISMISSED }]);
      const service = await makeService(db);
      const result = await service.dismissGap("org1", 1);
      expect(result.status).toBe(SupportKnowledgeGapStatus.DISMISSED);
    });
  });
});

describe("SupportKbGapJobHandler", () => {
  it("should have type property equal to support.kb-gap-detect", async () => {
    const { SupportKbGapJobHandler } = await import("./support-kb-gap-job.handler");
    const mockService = { detectGaps: jest.fn().mockResolvedValue({ created: 0, updated: 0 }) };
    const mockRegistry = { register: jest.fn() };
    const handler = new SupportKbGapJobHandler(mockService as never, mockRegistry as never);
    expect(handler.type).toBe("support.kb-gap-detect");
  });

  it("should register itself with the handler registry on module init", async () => {
    const { SupportKbGapJobHandler } = await import("./support-kb-gap-job.handler");
    const mockService = { detectGaps: jest.fn().mockResolvedValue({ created: 0, updated: 0 }) };
    const mockRegistry = { register: jest.fn() };
    const handler = new SupportKbGapJobHandler(mockService as never, mockRegistry as never);
    handler.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it("should delegate to detectGaps with orgId from payload", async () => {
    const { SupportKbGapJobHandler } = await import("./support-kb-gap-job.handler");
    const mockService = { detectGaps: jest.fn().mockResolvedValue({ created: 2, updated: 1 }) };
    const mockRegistry = { register: jest.fn() };
    const handler = new SupportKbGapJobHandler(mockService as never, mockRegistry as never);

    const result = await handler.handle({
      id: 1,
      orgId: "fallback",
      userId: null,
      payload: { orgId: "org-from-payload" },
    });

    expect(mockService.detectGaps).toHaveBeenCalledWith("org-from-payload");
    expect(result).toEqual({ created: 2, updated: 1 });
  });

  it("should fall back to job.orgId when payload.orgId is absent", async () => {
    const { SupportKbGapJobHandler } = await import("./support-kb-gap-job.handler");
    const mockService = { detectGaps: jest.fn().mockResolvedValue({ created: 0, updated: 0 }) };
    const mockRegistry = { register: jest.fn() };
    const handler = new SupportKbGapJobHandler(mockService as never, mockRegistry as never);

    await handler.handle({ id: 2, orgId: "fallback-org", userId: null, payload: {} });

    expect(mockService.detectGaps).toHaveBeenCalledWith("fallback-org");
  });
});
