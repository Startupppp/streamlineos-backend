import { Test, type TestingModule } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatMessageModerationService } from "./chat-message-moderation.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { CacheService } from "../../common/cache/cache.service";
import { MESSAGE_FANOUT_PROVIDER } from "./message-fanout.interface";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
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
  limit: jest.fn().mockResolvedValue([{ membershipId: 10, id: 1 }]),
  delete: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
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

const mockEntities = {
  resolve: jest.fn().mockResolvedValue([{ status: "resolved", card: {} }]),
  withResolvedReferences: jest.fn((_actor: unknown, rows: unknown[]) => Promise.resolve(rows)),
};

describe("ChatMessagesService", () => {
  let service: ChatMessagesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEntities.resolve.mockResolvedValue([{ status: "resolved", card: {} }]);
    mockOrgSettings.getSettings.mockResolvedValue({ maxAttachmentSizeMb: 25 });
    mockStorage.isValidFileKey.mockReturnValue(true);
    mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1, isPrivate: false });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 10 });
    mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 10, role: "MEMBER" });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AblyService, useValue: mockAbly },
        { provide: ChatReplyRemindersService, useValue: mockReplyReminders },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntityReferenceService, useValue: mockEntities },
        { provide: MESSAGE_FANOUT_PROVIDER, useValue: mockFanout },
      ],
    }).compile();
    service = module.get(ChatMessagesService);
  });

  describe("send", () => {
    it("DENY: a member of a record channel who has lost the record cannot post into it", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({
        id: 1,
        isPrivate: true,
        entityType: "project",
        entityId: "42",
      });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ role: "MEMBER" });
      mockEntities.resolve.mockResolvedValue([{ status: "unresolved", reference: { type: "project", id: "42" } }]);

      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("CONTROL: the same member posts once the record resolves again", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({
        id: 1,
        isPrivate: true,
        entityType: "project",
        entityId: "42",
      });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ role: "MEMBER" });
      mockEntities.resolve.mockResolvedValue([{ status: "resolved", card: {} }]);

      await service.send(1, "user1", "org1", { content: "hello", attachments: [] });
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("throws NotFoundException for a non-member of a PRIVATE channel, never confirming it exists", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1, isPrivate: true });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("CONTROL: a non-member of a PUBLIC channel still gets ForbiddenException", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1, isPrivate: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);
      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("CONTROL: a channel in another organization is NotFoundException before membership is read", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue(undefined);
      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDb.query.chatChannelMembers.findFirst).not.toHaveBeenCalled();
    });

    it("stores angle brackets verbatim; clients render text and the email sink escapes", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ userId: "user1" });
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1 });
      mockDb.query.users.findFirst.mockResolvedValue({ id: "user1", name: "Alice" });

      await service.send(1, "user1", "org1", { content: "if a<b and c>d then ok", attachments: [] });
      await service.send(1, "user1", "org1", { content: "<name>", attachments: [] });

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ content: "if a<b and c>d then ok" }),
      );
      expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({ content: "<name>" }));
    });

    it("refuses a post into an archived channel", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 1, type: "PUBLIC", isArchived: true }]);

      await expect(
        service.send(1, "user1", "org1", { content: "hello", attachments: [] }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("advances the sender's own read cursor, monotonically, in the send transaction", async () => {
      await service.send(1, "user1", "org1", { content: "hello", attachments: [] });

      const cursorWrite = mockDb.set.mock.calls
        .map(([values]: [Record<string, unknown>]) => values)
        .find((values) => "lastReadPosition" in values);
      expect(cursorWrite).toBeDefined();
      expect(new PgDialect().sqlToQuery(cursorWrite?.lastReadPosition as SQL).sql).toContain("GREATEST(");
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

  describe("forwarding a message's attachments into another channel", () => {
    const TARGET_CHANNEL = 2;
    const FORWARDED = {
      fileName: "quarterly.pdf",
      fileUrl: "https://public.example.com/permanent/quarterly.pdf",
      fileKey: "org1/chat/1f0c9d0e-4a7b-4c1e-9f3a-8b6d5e2c1a09-quarterly.pdf",
      fileSize: 4096,
      mimeType: "application/pdf",
    };

    function attachmentValues(): Record<string, unknown>[] {
      const call = mockDb.values.mock.calls[1];
      if (!call) throw new Error("no attachment insert was issued");
      const values = call[0];
      if (!Array.isArray(values)) throw new Error("the attachment insert is not a row array");
      return values as Record<string, unknown>[];
    }

    beforeEach(() => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: TARGET_CHANNEL, isPrivate: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 10, role: "MEMBER" });
      mockDb.query.users.findFirst.mockResolvedValue({ id: "user1", name: "Alice" });
    });

    it("never persists the client-supplied fileUrl, so a forward cannot plant a permanent public link", async () => {
      await service.send(TARGET_CHANNEL, "user1", "org1", {
        attachments: [FORWARDED],
        metadata: { forwardCount: 1 },
      });

      const rows = attachmentValues();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fileUrl: "" });
      expect(JSON.stringify(rows[0])).not.toContain("public.example.com");
    });

    it("binds the copied rows to the newly created message and the caller's org", async () => {
      await service.send(TARGET_CHANNEL, "user1", "org1", {
        attachments: [FORWARDED],
        metadata: { forwardCount: 1 },
      });

      expect(attachmentValues()[0]).toMatchObject({
        orgId: "org1",
        messageId: 1,
        fileKey: FORWARDED.fileKey,
        fileName: FORWARDED.fileName,
        fileSize: FORWARDED.fileSize,
        mimeType: FORWARDED.mimeType,
      });
    });

    it("writes the forwarded message against the TARGET channel, not the channel it came from", async () => {
      await service.send(TARGET_CHANNEL, "user1", "org1", {
        content: "sharing this",
        attachments: [FORWARDED],
        metadata: { forwardCount: 2 },
      });

      expect(mockDb.values).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          channelId: TARGET_CHANNEL,
          orgId: "org1",
          metadata: { forwardCount: 2 },
        }),
      );
    });

    it("DENY: forwarding into a channel the caller is not in never reaches the attachment work", async () => {
      mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: TARGET_CHANNEL, isPrivate: true });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue(null);

      await expect(
        service.send(TARGET_CHANNEL, "user1", "org1", {
          attachments: [FORWARDED],
          metadata: { forwardCount: 1 },
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockOrgSettings.getSettings).not.toHaveBeenCalled();
      expect(mockStorage.isValidFileKey).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("DENY: forwarding a key that belongs to another tenant is refused before the transaction", async () => {
      await expect(
        service.send(TARGET_CHANNEL, "user1", "org1", {
          attachments: [{ ...FORWARDED, fileKey: "org-other/chat/stolen.pdf" }],
          metadata: { forwardCount: 1 },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDb.transaction).not.toHaveBeenCalled();
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
    mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: 1, isPrivate: false });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: 10 });
    mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 10, role: "MEMBER" });
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
