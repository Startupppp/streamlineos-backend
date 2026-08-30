import { Test, type TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";

const mockDb = {
  query: {
    chatChannelMembers: { findFirst: jest.fn(), findMany: jest.fn() },
    chatChannels: { findFirst: jest.fn(), findMany: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
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

const mockEntities = {
  resolve: jest.fn().mockResolvedValue([{ status: "unresolved" }]),
  actionsFor: jest.fn().mockResolvedValue([[]]),
  submitAction: jest.fn(),
  isKnownType: jest.fn().mockReturnValue(true),
};

const mockCache = {
  cached: jest.fn().mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
};

describe("ChatChannelMembersService", () => {
  let service: ChatChannelMembersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatChannelMembersService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: EntityReferenceService, useValue: mockEntities },
      ],
    }).compile();
    service = module.get(ChatChannelMembersService);
  });

  describe("updateMemberRole", () => {
    it("throws ForbiddenException if requester is not ADMIN", async () => {
      mockDb.query.chatChannelMembers.findFirst
        .mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      await expect(service.updateMemberRole(1, "user2", "user1", "org1", "ADMIN")).rejects.toThrow(ForbiddenException);
    });

    it("updates role when requester is ADMIN", async () => {
      mockDb.query.chatChannelMembers.findFirst
        .mockResolvedValueOnce({ userId: "user1", role: "ADMIN" });
      mockDb.where.mockResolvedValue([{ userId: "user2", role: "ADMIN" }]);
      const result = await service.updateMemberRole(1, "user2", "user1", "org1", "ADMIN");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe("archiveChannel", () => {
    it("throws NotFoundException if channel not in org", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.archiveChannel(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("archives the channel for the current user", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      const result = await service.archiveChannel(1, "user1", "org1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("favoriteChannel", () => {
    it("throws NotFoundException if channel is cross-tenant", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.favoriteChannel(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is not a member", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.favoriteChannel(1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("marks the channel as favorite for the current user", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      const result = await service.favoriteChannel(1, "user1", "org1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("unfavoriteChannel", () => {
    it("unmarks the channel as favorite for the current user", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      const result = await service.unfavoriteChannel(1, "user1", "org1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  describe("setNotificationPreference", () => {
    it("throws NotFoundException for cross-tenant channel", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce(undefined);
      await expect(
        service.setNotificationPreference(1, "user1", "MENTIONS", "org1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is not a member", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      await expect(
        service.setNotificationPreference(1, "user1", "MENTIONS", "org1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("updates the notification preference for the current user", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: "user1", role: "MEMBER" });
      const result = await service.setNotificationPreference(1, "user1", "MENTIONS", "org1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, notificationPreference: "MENTIONS" });
    });
  });
});
