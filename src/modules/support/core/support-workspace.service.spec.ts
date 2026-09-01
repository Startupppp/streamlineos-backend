import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { SupportWorkspaceService } from "./support-workspace.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockDb = {
  query: {
    supportQueues: { findMany: jest.fn() },
    supportSavedViews: { findMany: jest.fn(), findFirst: jest.fn() },
    supportTags: { findFirst: jest.fn(), findMany: jest.fn() },
    supportTickets: { findFirst: jest.fn() },
    supportTicketWatchers: { findMany: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue([]),
};

describe("SupportWorkspaceService", () => {
  let service: SupportWorkspaceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.returning.mockResolvedValue([{ id: 1 }]);
    mockDb.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportWorkspaceService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportWorkspaceService);
  });

  describe("queues", () => {
    it("annotates queues with an open-ticket count", async () => {
      mockDb.query.supportQueues.findMany.mockResolvedValueOnce([{ id: 1, name: "Billing" }]);
      mockDb.groupBy.mockResolvedValueOnce([{ queueId: 1, cnt: 3 }]);

      const result = await service.listQueues("org1");

      expect(result).toEqual([{ id: 1, name: "Billing", openTicketCount: 3 }]);
    });

    it("throws NotFoundException updating a queue that doesn't exist in the org", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(service.updateQueue("org1", 999, { name: "x" } as never)).rejects.toThrow(NotFoundException);
    });
  });

  describe("saved views", () => {
    it("forbids editing another user's personal view", async () => {
      mockDb.query.supportSavedViews.findFirst.mockResolvedValueOnce({
        id: 1,
        ownerId: "other-user",
        visibility: "personal",
      });

      await expect(
        service.updateSavedView("org1", "me", null, 1, { name: "renamed" } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows editing your own personal view", async () => {
      mockDb.query.supportSavedViews.findFirst.mockResolvedValueOnce({
        id: 1,
        ownerId: "me",
        visibility: "personal",
      });
      mockDb.returning.mockResolvedValueOnce([{ id: 1, name: "renamed" }]);

      await expect(
        service.updateSavedView("org1", "me", null, 1, { name: "renamed" } as never),
      ).resolves.toMatchObject({ id: 1, name: "renamed" });
    });

    it("allows editing a team/global view regardless of ownerId", async () => {
      mockDb.query.supportSavedViews.findFirst.mockResolvedValueOnce({
        id: 1,
        ownerId: null,
        visibility: "team",
      });
      mockDb.returning.mockResolvedValueOnce([{ id: 1, name: "renamed" }]);

      await expect(
        service.updateSavedView("org1", "me", null, 1, { name: "renamed" } as never),
      ).resolves.toMatchObject({ id: 1, name: "renamed" });
    });
  });

  describe("tags", () => {
    it("rejects creating a duplicate tag name within the same org", async () => {
      mockDb.query.supportTags.findFirst.mockResolvedValueOnce({ id: 1 });

      await expect(service.createTag("org1", { name: "billing" } as never)).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException attaching a tag to a ticket outside the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.attachTag("org1", 999, 1)).rejects.toThrow(NotFoundException);
    });
  });

  describe("watchers", () => {
    it("throws NotFoundException following a ticket outside the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);

      await expect(service.follow("org1", 999, "user1")).rejects.toThrow(NotFoundException);
    });

    it("succeeds following a ticket that exists in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({ id: 1 });

      await expect(service.follow("org1", 1, "user1")).resolves.toEqual({ success: true });
    });
  });
});
