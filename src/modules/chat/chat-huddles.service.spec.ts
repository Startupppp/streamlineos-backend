import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatHuddlesService, HUDDLE_MESH_MAX_PARTICIPANTS } from "./chat-huddles.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { AuditService } from "../../common/audit/audit.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";

const mockDb = {
  query: {
    chatHuddles: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn(), findMany: jest.fn() },
    chatHuddleParticipants: { findMany: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, channelId: 1, startedByMembershipId: 1, status: "active", calendarEventId: null, startedAt: new Date(), endedAt: null, hasVideo: false }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  onConflictDoUpdate: jest.fn().mockResolvedValue([]),
};

const mockAbly = { publishHuddleEvent: jest.fn().mockResolvedValue(undefined), publishToUser: jest.fn().mockResolvedValue(undefined) };
const mockWebPush = { sendToUser: jest.fn().mockResolvedValue(undefined) };
const mockAudit = { log: jest.fn() };
const mockOrgSettings = {
  getSettings: jest.fn().mockResolvedValue({ maxHuddleParticipants: 50 }),
};
const mockPlanLimits = {
  resolveTier: jest.fn().mockResolvedValue({ tier: "PAID", plan: "STARTER" }),
};

describe("ChatHuddlesService", () => {
  let service: ChatHuddlesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
    mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHuddlesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: WebPushService, useValue: mockWebPush },
        { provide: AuditService, useValue: mockAudit },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    service = module.get(ChatHuddlesService);
  });

  describe("assertMember", () => {
    it("throws ForbiddenException if not member", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if org membership is not active (departed member)", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if channel is archived", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: true });
      await expect(service["assertMember"](1, "user1", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("returns the membershipId when valid", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const result = await service["assertMember"](1, "user1", "org1");
      expect(result).toBe(1);
    });
  });

  describe("leaveHuddle", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.leaveHuddle(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("ends huddle when last participant leaves", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1, calendarEventId: null });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:ended", expect.any(Object));
    });

    it("transfers host to next participant when host leaves with others remaining", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1, calendarEventId: null });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 2 }]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith(
        "org1", 1, "huddle:state_updated",
        expect.objectContaining({ hostTransferred: true, newHostMembershipId: 2 }),
      );
    });

    it("does not transfer host when a non-host leaves with others remaining", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 99, calendarEventId: null });
      mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 99 }]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "huddle:state_updated",
        expect.objectContaining({ hostTransferred: true }),
      );
    });
  });

  describe("kickParticipant", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.kickParticipant(1, "user1", "user2", "org1")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when non-host tries to kick (startedByMembershipId !== callerMembershipId)", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 99 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service.kickParticipant(1, "user1", "user2", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("allows host to kick a participant (startedByMembershipId === callerMembershipId)", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedByMembershipId: 1 });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.organizationMembers.findFirst
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });
      const result = await service.kickParticipant(1, "user1", "user2", "org1");
      expect(result).toEqual({ ok: true });
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:state_updated", expect.objectContaining({ kicked: true }));
    });
  });

  describe("setMute", () => {
    it("throws NotFoundException if huddle inactive", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.setMute(1, "user1", true, "org1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("setDeafen", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.setDeafen(1, "user1", "org1", true)).rejects.toThrow(NotFoundException);
    });
  });

  describe("joinHuddle", () => {
    it("throws NotFoundException if huddle not found or inactive", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.joinHuddle(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("rejects joining once the org's max participant cap is reached", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 2 });
      await expect(service.joinHuddle(1, "user2", "org1")).rejects.toThrow(ForbiddenException);
    });

    it("allows a participant already in the call to rejoin even when the cap is reached", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 1 }]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 1 });
      const result = await service.joinHuddle(1, "user1", "org1");
      expect(result).toEqual({ ok: true });
    });

    it("allows joining when under the cap", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([{ membershipId: 2 }]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
      const result = await service.joinHuddle(1, "user2", "org1");
      expect(result).toEqual({ ok: true });
    });

    it("FREE plan: third join throws ForbiddenException with upgrade message", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      await expect(service.joinHuddle(1, "user3", "org1")).rejects.toThrow(
        new ForbiddenException("Huddles are one-to-one on the Free plan. Upgrade to start group huddles."),
      );
    });

    it("PAID plan: third join is allowed subject to org max", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { membershipId: 2 },
        { membershipId: 3 },
      ]);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
      const result = await service.joinHuddle(1, "user3", "org1");
      expect(result).toEqual({ ok: true });
    });

    it("PAID plan: join beyond HUDDLE_MESH_MAX_PARTICIPANTS throws ForbiddenException even when org allows 50", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const existingParticipants = Array.from({ length: HUDDLE_MESH_MAX_PARTICIPANTS }, (_, i) => ({ membershipId: i + 2 }));
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue(existingParticipants);
      mockOrgSettings.getSettings.mockResolvedValue({ maxHuddleParticipants: 50 });
      await expect(service.joinHuddle(1, "newUser", "org1")).rejects.toThrow(
        new ForbiddenException(`This call is full (max ${HUDDLE_MESH_MAX_PARTICIPANTS} participants)`),
      );
    });
  });

  describe("inviteToHuddle", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.inviteToHuddle(1, "user1", "org1", ["user2"])).rejects.toThrow(NotFoundException);
    });

    it("FREE plan: invite when 2 active participants throws ForbiddenException", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "FREE", plan: "FREE" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([
        { id: 1 },
        { id: 2 },
      ]);
      await expect(service.inviteToHuddle(1, "user1", "org1", ["user3"])).rejects.toThrow(
        new ForbiddenException("Huddles are one-to-one on the Free plan. Upgrade to start group huddles."),
      );
    });

    it("PAID plan: invite proceeds regardless of participant count", async () => {
      mockPlanLimits.resolveTier.mockResolvedValue({ tier: "PAID", plan: "STARTER" });
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const result = await service.inviteToHuddle(1, "user1", "org1", ["user3"]);
      expect(result).toEqual({ ok: true });
      expect(mockAbly.publishToUser).toHaveBeenCalledWith("org1", "user3", "notification:huddle_invite", expect.any(Object));
    });
  });
});
