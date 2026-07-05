import { Test, type TestingModule } from "@nestjs/testing";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn(),
};

const mockAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };

const mockOrgSettings = {
  getSettings: jest.fn().mockResolvedValue({ defaultNotificationPreference: "ALL" }),
};

const baseMessage = {
  id: 1,
  content: "hello",
  senderId: "sender1",
  senderName: "Sender One",
};

describe("ChatNotificationsService", () => {
  let service: ChatNotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockOrgSettings.getSettings.mockResolvedValue({ defaultNotificationPreference: "ALL" });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatNotificationsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
      ],
    }).compile();
    service = module.get(ChatNotificationsService);
  });

  describe("publishNewMessageNotification", () => {
    it("skips the sender", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "sender1", mutedUntil: null, notificationPreference: "ALL" },
      ]);
      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
      expect(mockAbly.publishToUser).not.toHaveBeenCalled();
    });

    it("skips a member who has muted the channel", async () => {
      mockDb.where.mockResolvedValueOnce([
        {
          userId: "user2",
          mutedUntil: new Date(Date.now() + 3600_000),
          notificationPreference: "ALL",
        },
      ]);
      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
      expect(mockAbly.publishToUser).not.toHaveBeenCalled();
    });

    it("delivers to a member whose mute has expired", async () => {
      mockDb.where.mockResolvedValueOnce([
        {
          userId: "user2",
          mutedUntil: new Date(Date.now() - 3600_000),
          notificationPreference: "ALL",
        },
      ]);
      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
      expect(mockAbly.publishToUser).toHaveBeenCalledWith(
        "org1",
        "user2",
        "notification:message",
        expect.objectContaining({ channelId: 1 }),
      );
    });

    it.each(["MENTIONS", "NOTHING"])(
      "skips a member with notification preference %s",
      async (preference) => {
        mockDb.where.mockResolvedValueOnce([
          { userId: "user2", mutedUntil: null, notificationPreference: preference },
        ]);
        await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
        expect(mockAbly.publishToUser).not.toHaveBeenCalled();
      },
    );

    it("delivers to a member with DEFAULT or ALL preference", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", mutedUntil: null, notificationPreference: "DEFAULT" },
      ]);
      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
      expect(mockAbly.publishToUser).toHaveBeenCalledTimes(1);
    });

    it("resolves DEFAULT against the org's configured default and suppresses when the org default is NOTHING", async () => {
      mockOrgSettings.getSettings.mockResolvedValueOnce({ defaultNotificationPreference: "NOTHING" });
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", mutedUntil: null, notificationPreference: "DEFAULT" },
      ]);
      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");
      expect(mockAbly.publishToUser).not.toHaveBeenCalled();
    });
  });

  describe("publishMentionNotification", () => {
    it("does nothing when there are no mentioned users", async () => {
      await service.publishMentionNotification("org1", 1, baseMessage, []);
      expect(mockDb.where).not.toHaveBeenCalled();
      expect(mockAbly.publishToUser).not.toHaveBeenCalled();
    });

    it("skips a mentioned member who opted out of all notifications", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", notificationPreference: "NOTHING" },
      ]);
      await service.publishMentionNotification("org1", 1, baseMessage, ["user2"]);
      expect(mockAbly.publishToUser).not.toHaveBeenCalled();
    });

    it("delivers a mention even when preference is MENTIONS only", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", notificationPreference: "MENTIONS" },
      ]);
      await service.publishMentionNotification("org1", 1, baseMessage, ["user2"]);
      expect(mockAbly.publishToUser).toHaveBeenCalledWith(
        "org1",
        "user2",
        "notification:mention",
        expect.objectContaining({ channelId: 1 }),
      );
    });
  });
});
