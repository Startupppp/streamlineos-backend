import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { SupportCsatService } from "./support-csat.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockDb = {
  query: {
    supportCsatRequests: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTickets: { findFirst: jest.fn() },
    csatSurveys: { findMany: jest.fn().mockResolvedValue([]) },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, score: 5 }]),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
};

describe("SupportCsatService", () => {
  let service: SupportCsatService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.onConflictDoNothing.mockResolvedValue(undefined);
    mockDb.returning.mockResolvedValue([{ id: 1, score: 5 }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportCsatService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportCsatService);
  });

  describe("createRequestForTicket", () => {
    it("throws NotFoundException when the ticket doesn't belong to the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.createRequestForTicket("org1", 999)).rejects.toThrow(NotFoundException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("inserts idempotently (onConflictDoNothing keyed on ticketId) when the ticket exists", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 });

      await service.createRequestForTicket("org1", 1);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("throws NotFoundException for an unknown token", async () => {
      mockDb.query.supportCsatRequests.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.submit("bad-token", { score: 5 } as never)).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException when the survey was already answered", async () => {
      mockDb.query.supportCsatRequests.findFirst.mockResolvedValueOnce({
        id: 1,
        respondedAt: new Date(),
      });

      await expect(service.submit("used-token", { score: 5 } as never)).rejects.toThrow(ConflictException);
    });

    it("records the score/comment on first submission", async () => {
      mockDb.query.supportCsatRequests.findFirst.mockResolvedValueOnce({ id: 1, respondedAt: null });
      mockDb.returning.mockResolvedValueOnce([{ id: 1, score: 4 }]);

      const result = await service.submit("fresh-token", { score: 4, comment: "great support" } as never);

      expect(result).toEqual({ success: true, score: 4 });
    });
  });

  describe("getReport", () => {
    it("computes response rate and average score, ignoring unresponded requests", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([
        { score: 5, respondedAt: new Date() },
        { score: 3, respondedAt: new Date() },
        { score: null, respondedAt: null },
        { score: null, respondedAt: null },
      ]);

      const report = await service.getReport("org1");

      expect(report).toMatchObject({
        totalRequests: 4,
        totalResponses: 2,
        responseRate: 0.5,
        averageScore: 4,
      });
      expect(report.sources.ticket).toMatchObject({
        totalRequests: 4,
        totalResponses: 2,
        responseRate: 0.5,
        averageScore: 4,
      });
    });

    it("returns a null average when nobody has responded yet", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([{ score: null, respondedAt: null }]);

      const report = await service.getReport("org1");

      expect(report.averageScore).toBeNull();
      expect(report.responseRate).toBe(0);
    });

    it("excludes the general surveys module explicitly, with a reason, rather than silently omitting it", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([]);

      const report = await service.getReport("org1");

      expect(report.sources.generalSurveys).toMatchObject({ excluded: true });
      expect(report.sources.generalSurveys.reason).toContain("normalized satisfaction rating");
    });

    it("returns null crmCampaigns when the org has no CRM CSAT campaigns at all", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([]);
      mockDb.query.csatSurveys.findMany.mockResolvedValueOnce([]);

      const report = await service.getReport("org1");

      expect(report.sources.crmCampaigns).toBeNull();
    });

    it("reports zero responses distinctly from no campaigns at all", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([]);
      mockDb.query.csatSurveys.findMany.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.where.mockResolvedValueOnce([]);

      const report = await service.getReport("org1");

      expect(report.sources.crmCampaigns).toEqual({ totalSurveys: 1, totalResponses: 0, averageScore: null });
    });

    it("normalizes crmCampaigns ratings onto the same 1-5 scale as ticket CSAT before averaging", async () => {
      mockDb.query.supportCsatRequests.findMany.mockResolvedValueOnce([]);
      mockDb.query.csatSurveys.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
      // a 10-point-scale survey rated 8/10 (=4/5) and a 5-point-scale survey rated 5/5 (=5/5)
      mockDb.where.mockResolvedValueOnce([
        { rating: 8, scaleMax: 10 },
        { rating: 5, scaleMax: 5 },
      ]);

      const report = await service.getReport("org1");

      expect(report.sources.crmCampaigns).toEqual({ totalSurveys: 2, totalResponses: 2, averageScore: 4.5 });
    });
  });
});
