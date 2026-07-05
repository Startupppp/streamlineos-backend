import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    chatChannelMembers: { findFirst: jest.fn() },
    chatChannelInviteLinks: { findFirst: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

describe("ChatInviteLinksService", () => {
  let service: ChatInviteLinksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatInviteLinksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(ChatInviteLinksService);
  });

  describe("getOrCreateInviteLink", () => {
    it("throws ForbiddenException if requester is not an admin", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        role: "MEMBER",
      });
      await expect(service.getOrCreateInviteLink(1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("returns the existing active token without creating a new one", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        role: "ADMIN",
      });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ token: "existing-token" });
      const result = await service.getOrCreateInviteLink(1, "user1");
      expect(result).toEqual({ token: "existing-token" });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates a new token when none exists", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        role: "ADMIN",
      });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.getOrCreateInviteLink(1, "user1");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
    });
  });

  describe("regenerateInviteLink", () => {
    it("revokes the old link and issues a new token", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        role: "ADMIN",
      });
      const result = await service.regenerateInviteLink(1, "user1");
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
    });
  });

  describe("joinViaInviteLink", () => {
    it("throws NotFoundException for an unknown or revoked token", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.joinViaInviteLink("bad-token", "user1", "org1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when the channel belongs to a different org", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({
        channelId: 1,
        token: "tok",
      });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1, orgId: "other-org" });
      await expect(service.joinViaInviteLink("tok", "user1", "org1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("adds the user as a member when the token and org are valid", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({
        channelId: 1,
        token: "tok",
      });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1, orgId: "org1" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.joinViaInviteLink("tok", "user1", "org1");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: 1 });
    });

    it("does not insert a duplicate membership when the user already belongs", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({
        channelId: 1,
        token: "tok",
      });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: 1, orgId: "org1" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({
        userId: "user1",
        channelId: 1,
      });
      const result = await service.joinViaInviteLink("tok", "user1", "org1");
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: 1 });
    });
  });
});
