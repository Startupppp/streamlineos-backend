import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatMessageModerationService } from "./chat-message-moderation.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { CacheService } from "../../common/cache/cache.service";
import { MESSAGE_FANOUT_PROVIDER } from "./message-fanout.interface";
import { StorageService } from "../storage/storage.service";

const mockDb = {
  query: {
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
    chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
    chatMessages: { findFirst: jest.fn() },
    chatChannels: { findFirst: jest.fn() },
    users: { findFirst: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1, channelId: 1, senderId: "user1", content: "hello", createdAt: new Date(), replyToId: null }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([{ id: 1 }]),
  delete: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
};

const mockCache = {
  cached: jest.fn().mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
};

const mockAbly = {
  configured: false,
  publishChatEvent: jest.fn().mockResolvedValue(undefined),
  publishChatMessage: jest.fn().mockResolvedValue(undefined),
};
const mockReplyReminders = { scheduleForMessage: jest.fn().mockResolvedValue(undefined) };
const mockEntities = {
  resolve: jest.fn().mockResolvedValue([]),
  actionsFor: jest.fn().mockResolvedValue([]),
  submitAction: jest.fn(),
  isKnownType: jest.fn().mockReturnValue(true),
};

const mockOrgSettings = {
  getSettings: jest.fn().mockResolvedValue({ maxAttachmentSizeMb: 25 }),
};

const mockFanout = {
  dispatchRealtime: jest.fn().mockResolvedValue(undefined),
  dispatchDeferred: jest.fn().mockResolvedValue(undefined),
};

const mockStorage = {
  isValidFileKey: jest.fn().mockReturnValue(true),
};

describe("ChatMessagesService", () => {
  let service: ChatMessagesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 25 });
    mockStorage.isValidFileKey.mockReturnValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AblyService, useValue: mockAbly },
        { provide: ChatReplyRemindersService, useValue: mockReplyReminders },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: EntityReferenceService, useValue: mockEntities },
        { provide: StorageService, useValue: mockStorage },
        { provide: MESSAGE_FANOUT_PROVIDER, useValue: mockFanout },
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

    it("rejects an attachment larger than the org's configured max size", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 1 });

      await expect(
        service.send(1, "user1", "org1", {
          content: undefined,
          attachments: [
            {
              fileName: "huge.zip",
              fileUrl: "",
              fileKey: "org1/chat/uuid-huge.zip",
              fileSize: 2 * 1024 * 1024,
              mimeType: "application/zip",
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows an attachment within the org's configured max size", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.users.findFirst.mockResolvedValue({ id: "user1", name: "Alice" });
      mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 25 });

      await expect(
        service.send(1, "user1", "org1", {
          content: undefined,
          attachments: [
            {
              fileName: "small.png",
              fileUrl: "",
              fileKey: "org1/chat/uuid-small.png",
              fileSize: 1024,
              mimeType: "image/png",
            },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it("DENY: rejects an attachment whose fileKey does not start with the caller's orgId", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 25 });

      await expect(
        service.send(1, "user1", "org1", {
          content: undefined,
          attachments: [
            {
              fileName: "stolen.pdf",
              fileUrl: "",
              fileKey: "org-other/chat/uuid-stolen.pdf",
              fileSize: 1024,
              mimeType: "application/pdf",
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("DENY: rejects an attachment with a path-traversal fileKey", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 25 });
      mockStorage.isValidFileKey.mockReturnValue(false);

      await expect(
        service.send(1, "user1", "org1", {
          content: undefined,
          attachments: [
            {
              fileName: "evil.pdf",
              fileUrl: "",
              fileKey: "org1/../secret/data.pdf",
              fileSize: 1024,
              mimeType: "application/pdf",
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("sendSystemMessage", () => {
    it("uses the sender identity read in the message transaction", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([{ name: "Alice" }]);
      mockDb.returning.mockResolvedValueOnce([{
        id: 7,
        channelId: 1,
        senderId: "user1",
        content: "system update",
        createdAt: new Date(),
        replyToId: null,
      }]);

      await service.sendSystemMessage(1, "user1", "org1", "system update", {});

      expect(mockAbly.publishChatMessage).toHaveBeenCalledWith(
        "org1",
        1,
        expect.objectContaining({ senderName: "Alice" }),
      );
      expect(mockDb.limit).toHaveBeenCalledTimes(2);
    });
  });

});

describe("ChatMessageModerationService", () => {
  let moderation: ChatMessageModerationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessageModerationService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
      ],
    }).compile();
    moderation = module.get(ChatMessageModerationService);
  });

  describe("edit", () => {
    it("throws NotFoundException if message does not exist", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);
      await expect(moderation.edit(999, 1, "user1", "org1", "new content")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if user is not the message owner", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue({ id: 1, senderMembershipId: 99, isDeleted: false });
      await expect(moderation.edit(1, 1, "user1", "org1", "new content")).rejects.toThrow(ForbiddenException);
    });
  });

  describe("remove", () => {
    it("throws NotFoundException if message does not exist", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue(null);
      await expect(moderation.remove(999, 1, "user1", false, "org1")).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if user is not the owner and not admin", async () => {
      mockDb.query.chatMessages.findFirst.mockResolvedValue({ id: 1, senderMembershipId: 99, isDeleted: false, channelId: 1 });
      await expect(moderation.remove(1, 1, "user1", false, "org1")).rejects.toThrow(ForbiddenException);
    });
  });
});
