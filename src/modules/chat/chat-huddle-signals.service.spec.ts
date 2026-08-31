import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";

const mockDb = {
  query: {
    chatHuddles: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
    chatHuddleParticipants: { findMany: jest.fn() },
    organizationMembers: { findFirst: jest.fn() },
  },
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
};

const mockAbly = { publishHuddleEvent: jest.fn().mockResolvedValue(undefined), publishHuddleSignal: jest.fn().mockResolvedValue(undefined) };

describe("ChatHuddleSignalsService", () => {
  let service: ChatHuddleSignalsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 1 });
    mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ membershipId: 1 });
    mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHuddleSignalsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
      ],
    }).compile();
    service = module.get(ChatHuddleSignalsService);
  });

  describe("setMute", () => {
    it("throws NotFoundException if huddle inactive", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.setMute(1, "user1", true, "org1")).rejects.toThrow(NotFoundException);
    });

    it("publishes state_updated event on success", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      await service.setMute(1, "user1", true, "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:state_updated", expect.objectContaining({ isMuted: true }));
    });
  });

  describe("setDeafen", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.setDeafen(1, "user1", "org1", true)).rejects.toThrow(NotFoundException);
    });

    it("publishes state_updated event on success", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active" });
      await service.setDeafen(1, "user1", "org1", true);
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:state_updated", expect.objectContaining({ isDeafened: true }));
    });
  });

  describe("heartbeat", () => {
    it("returns ok:true even when caller has no membership", async () => {
      mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);
      const result = await service.heartbeat(1, "user1", "org1");
      expect(result).toEqual({ ok: true });
    });
  });

  describe("raiseHand", () => {
    it("throws NotFoundException when huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.raiseHand(1, "user1", true, "org1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("sendSignal", () => {
    it("throws NotFoundException when huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.sendSignal(1, "user1", { targetUserId: "user2", type: "offer", payload: {} }, "org1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("setScreenShare", () => {
    it("throws NotFoundException when huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.setScreenShare(1, "user1", true, "org1")).rejects.toThrow(NotFoundException);
    });
  });
});
