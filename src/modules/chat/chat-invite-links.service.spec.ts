import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const CHANNEL_ID = 1;
const ORG_ID = "org1";
const USER_ID = "user1";
const MEMBERSHIP_ID = 42;
const LINK_ID = 99;

const makeUpdateChain = (returningValue: Array<{ id: number }> = [{ id: LINK_ID }]) => ({
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      returning: jest.fn().mockResolvedValue(returningValue),
    }),
  ),
});

const makeInsertChain = (returningValue: Array<{ id: number }> = [{ id: LINK_ID }]) => ({
  values: jest.fn().mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returningValue),
      }),
      returning: jest.fn().mockResolvedValue(returningValue),
    }),
  ),
});

function buildMockDb() {
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn() },
      chatChannelMembers: { findFirst: jest.fn() },
      chatChannelInviteLinks: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  };
  db.insert.mockReturnValue(makeInsertChain());
  db.update.mockReturnValue(makeUpdateChain());
  db.transaction.mockImplementation((cb: (tx: typeof db) => unknown) => cb(db));
  return db;
}

let mockDb: ReturnType<typeof buildMockDb>;

describe("ChatInviteLinksService", () => {
  let service: ChatInviteLinksService;

  beforeEach(async () => {
    mockDb = buildMockDb();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_ID });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatInviteLinksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(ChatInviteLinksService);
  });

  describe("getOrCreateInviteLink", () => {
    it("throws NotFoundException when caller is not in the org", async () => {
      mockDb.query.organizationMembers.findFirst.mockResolvedValueOnce(null);
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when caller is not a member of this channel", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(null);
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is not an admin", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "MEMBER", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(ForbiddenException);
    });

    it("returns the existing active token without creating a new one", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({
        token: "existing-token",
        tokenEncrypted: null,
        expiresAt: null,
        maxUses: null,
        useCount: 0,
      });
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(result).toEqual({ token: "existing-token", expiresAt: null, maxUses: null, useCount: 0 });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates a new token when none exists and the transaction callback is invoked", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
    });

    it("respects ttlSeconds: expiresAt is set to approximately now + ttl", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const before = Date.now();
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { ttlSeconds: 3600 });
      const after = Date.now();
      expect(result.expiresAt).toBeInstanceOf(Date);
      const ts = (result.expiresAt as Date).getTime();
      expect(ts).toBeGreaterThanOrEqual(before + 3599_000);
      expect(ts).toBeLessThanOrEqual(after + 3601_000);
    });

    it("respects maxUses: returned in the response", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { maxUses: 5 });
      expect(result.maxUses).toBe(5);
      expect(result.useCount).toBe(0);
    });
  });

  describe("regenerateInviteLink", () => {
    it("revokes the old link and issues a new token", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const result = await service.regenerateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
    });

    it("respects ttlSeconds and maxUses on regenerate", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const result = await service.regenerateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { ttlSeconds: 7200, maxUses: 10 });
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.maxUses).toBe(10);
    });
  });

  describe("joinViaInviteLink", () => {
    it("throws NotFoundException for an unknown or revoked token (SQL predicate returns no row)", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.joinViaInviteLink("bad-token", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws the SAME NotFoundException message for an expired link, leaving no oracle", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      let msg1: string | undefined;
      try {
        await service.joinViaInviteLink("expired-token", USER_ID, ORG_ID);
      } catch (e) {
        msg1 = e instanceof NotFoundException ? e.message : undefined;
      }

      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      let msg2: string | undefined;
      try {
        await service.joinViaInviteLink("exhausted-token", USER_ID, ORG_ID);
      } catch (e) {
        msg2 = e instanceof NotFoundException ? e.message : undefined;
      }

      expect(msg1).toBeDefined();
      expect(msg1).toBe(msg2);
    });

    it("throws NotFoundException when the channel belongs to a different org (DB returns null because WHERE filters orgId)", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when the channel is archived", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: true });
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("adds the user as a member and increments use_count when the token and org are valid", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });

    it("does NOT insert a duplicate membership or increment use_count when the user already belongs", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ id: 7 });
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });

    it("throws NotFoundException if the link becomes invalid between the outer check and the use_count increment", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      mockDb.update.mockReturnValueOnce({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([]),
          }),
        ),
      });
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });
  });
});
