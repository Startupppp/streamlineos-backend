import { Test, type TestingModule } from "@nestjs/testing";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AblyService } from "../realtime/ably.service";
import { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const mockDb = {
  select: jest.fn(),
  from: jest.fn(),
  innerJoin: jest.fn(),
  where: jest.fn(),
};

const mockAbly = { publishToUser: jest.fn() };

const mockOrgSettings = {
  getSettings: jest.fn(),
};
const mockEffects = {
  execute: jest.fn(),
  executeBatch: jest.fn(),
};
const mockDispatch = { emitNow: jest.fn() };

const baseMessage = {
  id: 1,
  senderUserId: "sender1" as string | null,
  senderName: "Sender One",
};

describe("ChatNotificationsService", () => {
  let service: ChatNotificationsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();
    mockAbly.publishToUser.mockResolvedValue(undefined);
    mockOrgSettings.getSettings.mockResolvedValue({ defaultNotificationPreference: "ALL" });
    mockEffects.execute.mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED";
    });
    mockEffects.executeBatch.mockImplementation(
      async (items: Array<{ effect: unknown; send: () => Promise<void> }>) => {
        for (const { send } of items) await send();
      },
    );
    mockDispatch.emitNow.mockResolvedValue({ eventKey: "chat.message.mention", notified: 1, deliveriesQueued: 0, suppressed: 0, deduped: 0, deferred: false, failedRecipients: 0 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatNotificationsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AblyService, useValue: mockAbly },
        { provide: ChatOrgSettingsService, useValue: mockOrgSettings },
        { provide: ExternalEffectLedger, useValue: mockEffects },
        { provide: NotificationDispatchService, useValue: mockDispatch },
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

    it("publishes a signal, never the message body", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", mutedUntil: null, notificationPreference: "ALL" },
      ]);

      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP");

      const payload = mockAbly.publishToUser.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("content");
      expect(Object.values(payload)).not.toContain("hello");
      expect(payload).toMatchObject({ channelId: 1, messageId: 1, senderId: "sender1" });
    });

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

    it("calls executeBatch once for N recipients when idempotencyKey is provided — not N execute calls", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", mutedUntil: null, notificationPreference: "ALL" },
        { userId: "user3", mutedUntil: null, notificationPreference: "ALL" },
        { userId: "user4", mutedUntil: null, notificationPreference: "ALL" },
      ]);

      await service.publishNewMessageNotification("org1", 1, baseMessage, "GROUP", "event-1:dm");

      expect(mockEffects.execute).not.toHaveBeenCalled();
      expect(mockEffects.executeBatch).toHaveBeenCalledTimes(1);
      const [items] = mockEffects.executeBatch.mock.calls[0] as [
        Array<{ effect: { effectKey: string } }>,
      ];
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.effect.effectKey).sort()).toEqual(
        ["event-1:dm:user2", "event-1:dm:user3", "event-1:dm:user4"].sort(),
      );
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

    it("calls executeBatch once for N recipients when idempotencyKey is provided — not N execute calls", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", notificationPreference: "ALL" },
        { userId: "user3", notificationPreference: "ALL" },
        { userId: "user4", notificationPreference: "ALL" },
      ]);

      await service.publishMentionNotification(
        "org1",
        1,
        baseMessage,
        ["user2", "user3", "user4"],
        "event-1:mention",
      );

      expect(mockEffects.execute).not.toHaveBeenCalled();
      expect(mockEffects.executeBatch).toHaveBeenCalledTimes(1);
      const [items] = mockEffects.executeBatch.mock.calls[0] as [
        Array<{ effect: { effectKey: string } }>,
      ];
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.effect.effectKey).sort()).toEqual(
        ["event-1:mention:user2", "event-1:mention:user3", "event-1:mention:user4"].sort(),
      );
    });

    it("delivers all recipients directly when no idempotencyKey is given", async () => {
      mockDb.where.mockResolvedValueOnce([
        { userId: "user2", notificationPreference: "ALL" },
        { userId: "user3", notificationPreference: "ALL" },
      ]);

      await service.publishMentionNotification("org1", 1, baseMessage, ["user2", "user3"]);

      expect(mockEffects.executeBatch).not.toHaveBeenCalled();
      expect(mockAbly.publishToUser).toHaveBeenCalledTimes(2);
    });
  });
});
