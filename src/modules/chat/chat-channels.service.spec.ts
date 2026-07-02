import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ChatChannelsService } from "./chat-channels.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    chatChannelMembers: { findFirst: jest.fn(), findMany: jest.fn() },
    chatChannels: { findFirst: jest.fn(), findMany: jest.fn() },
    users: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, orgId: "org1", name: "general", type: "GROUP", isArchived: false }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
};

describe("ChatChannelsService", () => {
  let service: ChatChannelsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatChannelsService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    service = module.get(ChatChannelsService);
  });

  describe("addMember", () => {
    it("throws ConflictException if user is already a member", async () => {
      mockDb.query.chatChannelMembers.findFirst
        .mockResolvedValueOnce({ userId: "user1", role: "ADMIN" })
        .mockResolvedValueOnce({ userId: "user2" });
      await expect(service.addMember(1, "user2", "user1")).rejects.toThrow(ConflictException);
    });
  });

  describe("updateMemberRole", () => {
    it("throws ForbiddenException if requester is not ADMIN", async () => {
      mockDb.query.chatChannelMembers.findFirst
        .mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      await expect(service.updateMemberRole(1, "user2", "user1", "ADMIN")).rejects.toThrow(ForbiddenException);
    });

    it("updates role when requester is ADMIN", async () => {
      mockDb.query.chatChannelMembers.findFirst
        .mockResolvedValueOnce({ userId: "user1", role: "ADMIN" });
      mockDb.where.mockResolvedValue([{ userId: "user2", role: "ADMIN" }]);
      const result = await service.updateMemberRole(1, "user2", "user1", "ADMIN");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe("archiveChannel", () => {
    it("archives the channel for the current user", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        role: "MEMBER",
      });
      const result = await service.archiveChannel(1, "user1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });
});
