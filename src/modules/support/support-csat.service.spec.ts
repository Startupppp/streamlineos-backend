import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { SupportCsatService } from "./support-csat.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportCsatRequests: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTickets: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, score: 5 }]),
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

      expect(report).toEqual({
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
  });
});
