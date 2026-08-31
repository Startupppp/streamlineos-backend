import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const CHANNEL_ID = 1;
const ORG_ID = "org1";
const USER_ID = "user1";

const mockDb = {
  query: {
    chatChannels: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn() },
    chatChannelInviteLinks: { findFirst: jest.fn() },
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
    jest.resetAllMocks();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockResolvedValue(undefined);
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.where.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatInviteLinksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(ChatInviteLinksService);
  });

  describe("getOrCreateInviteLink", () => {
    it("throws NotFoundException when caller is not a member of this org's channel", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(null);
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is not an admin", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: USER_ID, role: "MEMBER" });
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(ForbiddenException);
    });

    it("returns the existing active token without creating a new one", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: USER_ID, role: "ADMIN", orgId: ORG_ID, membershipId: null });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ token: "existing-token", tokenEncrypted: null });
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(result).toEqual({ token: "existing-token" });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates a new token when none exists", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: USER_ID, role: "ADMIN", orgId: ORG_ID, membershipId: null });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
    });
  });

  describe("regenerateInviteLink", () => {
    it("revokes the old link and issues a new token", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: USER_ID, role: "ADMIN", orgId: ORG_ID, membershipId: null });
      const result = await service.regenerateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
    });
  });

  describe("joinViaInviteLink", () => {
    it("throws NotFoundException for an unknown or revoked token", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.joinViaInviteLink("bad-token", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when the channel belongs to a different org", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ channelId: CHANNEL_ID, token: "tok", tokenHash: "h" });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: "other-org" });
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("adds the user as a member when the token and org are valid", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ channelId: CHANNEL_ID, token: "tok", tokenHash: "h" });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });

    it("does not insert a duplicate membership when the user already belongs", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ channelId: CHANNEL_ID, token: "tok", tokenHash: "h" });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ userId: USER_ID, channelId: CHANNEL_ID });
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });
  });
});
