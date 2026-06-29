import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatHuddlesService } from "./chat-huddles.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { AuditService } from "../../common/audit/audit.service";

const mockDb = {
  query: {
    chatHuddles: { findFirst: jest.fn() },
    chatChannelMembers: { findFirst: jest.fn(), findMany: jest.fn() },
    chatHuddleParticipants: { findMany: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, channelId: 1, startedBy: "user1", status: "active", calendarEventId: null, startedAt: new Date(), endedAt: null, hasVideo: false }]),
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

describe("ChatHuddlesService", () => {
  let service: ChatHuddlesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHuddlesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: WebPushService, useValue: mockWebPush },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    service = module.get(ChatHuddlesService);
  });

  describe("assertMember", () => {
    it("throws ForbiddenException if not member", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      await expect(service["assertMember"](1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if channel is archived", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1", role: "MEMBER" });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: true });
      await expect(service["assertMember"](1, "user1")).rejects.toThrow(ForbiddenException);
    });

    it("returns member if valid", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1", role: "MEMBER" });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ isArchived: false });
      const result = await service["assertMember"](1, "user1");
      expect(result).toEqual({ userId: "user1", role: "MEMBER" });
    });
  });

  describe("leaveHuddle", () => {
    it("throws NotFoundException if huddle not found", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue(null);
      await expect(service.leaveHuddle(1, "user1", "org1")).rejects.toThrow(NotFoundException);
    });

    it("ends huddle when last participant leaves", async () => {
      mockDb.query.chatHuddles.findFirst.mockResolvedValue({ id: 1, channelId: 1, status: "active", startedBy: "user1", calendarEventId: null });
      mockDb.query.chatHuddleParticipants.findMany.mockResolvedValue([]);
      await service.leaveHuddle(1, "user1", "org1");
      expect(mockAbly.publishHuddleEvent).toHaveBeenCalledWith("org1", 1, "huddle:ended", expect.any(Object));
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
});
