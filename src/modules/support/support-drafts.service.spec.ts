import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { SupportDraftsService } from "./support-drafts.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportTickets: { findFirst: jest.fn() },
    supportTicketDrafts: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

describe("SupportDraftsService", () => {
  let service: SupportDraftsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.supportTickets.findFirst.mockResolvedValue({ id: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportDraftsService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportDraftsService);
  });

  describe("getDraft", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.getDraft("org1", 1, "user1")).rejects.toThrow(NotFoundException);
    });

    it("returns null when the user has no draft for this ticket", async () => {
      mockDb.query.supportTicketDrafts.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.getDraft("org1", 1, "user1")).resolves.toBeNull();
    });

    it("returns the user's existing draft", async () => {
      mockDb.query.supportTicketDrafts.findFirst.mockResolvedValueOnce({
        id: 1,
        ticketId: 1,
        userId: "user1",
        body: "unsent reply",
        isInternal: false,
      });

      await expect(service.getDraft("org1", 1, "user1")).resolves.toMatchObject({ body: "unsent reply" });
    });
  });

  describe("upsertDraft", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(
        service.upsertDraft("org1", 1, "user1", { body: "draft text", isInternal: false } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it("upserts the draft via onConflictDoUpdate targeting (ticketId, userId)", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 1, ticketId: 1, userId: "user1", body: "draft text" }]);

      const result = await service.upsertDraft("org1", 1, "user1", { body: "draft text", isInternal: false } as never);

      expect(result).toMatchObject({ body: "draft text" });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe("deleteDraft", () => {
    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.deleteDraft("org1", 1, "user1")).rejects.toThrow(NotFoundException);
    });

    it("deletes the user's draft for this ticket", async () => {
      await expect(service.deleteDraft("org1", 1, "user1")).resolves.toEqual({ success: true });
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
