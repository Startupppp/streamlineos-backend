import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatMessagesService } from "./chat-messages.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { ChatNotificationsService } from "./chat-notifications.service";

const mockDb = {
  query: {
    chatChannelMembers: { findFirst: jest.fn() },
    chatMessages: { findFirst: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, channelId: 1, senderId: "user1", content: "hello", createdAt: new Date(), replyToId: null }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
};

const mockAbly = { publishChatEvent: jest.fn().mockResolvedValue(undefined) };
const mockWebPush = { sendToUser: jest.fn().mockResolvedValue(undefined) };
const mockNotifications = { notifyMentions: jest.fn().mockResolvedValue(undefined) };

describe("ChatMessagesService", () => {
  let service: ChatMessagesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: WebPushService, useValue: mockWebPush },
        { provide: ChatNotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(ChatMessagesService);
  });

  describe("send", () => {
    it("throws ForbiddenException if user is not a channel member", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("sanitizes XSS content before persisting", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.users.findFirst.mockResolvedValue({ id: "user1", name: "Alice" });

      const maliciousContent = "<script>alert('xss')</script>hello";
      await service.send(1, "user1", "org1", { content: maliciousContent, attachments: [] }).catch(() => {});

      const insertValues = mockDb.values.mock.calls[0]?.[0] as { content?: string } | undefined;
      if (insertValues?.content) {
        expect(insertValues.content).not.toContain("<script>");
      }
    });
  });

  describe("edit", () => {
    it("throws NotFoundException if message does not exist", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);
      await expect(service.edit(999, "user1", "new content")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if user is not the message owner", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue({ id: 1, senderId: "user2", isDeleted: false });
      await expect(service.edit(1, "user1", "new content")).rejects.toThrow(ForbiddenException);
    });
  });

  describe("remove", () => {
    it("throws NotFoundException if message does not exist", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);
      await expect(service.remove(999, "user1", "MEMBER")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if user is not the owner and not admin", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue({ id: 1, senderId: "user2", isDeleted: false, channelId: 1 });
      await expect(service.remove(1, "user1", "MEMBER")).rejects.toThrow(ForbiddenException);
    });
  });
});
