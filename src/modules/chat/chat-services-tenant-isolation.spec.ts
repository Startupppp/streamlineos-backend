jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { ForbiddenException } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { ChatPresenceService } from "./chat-presence.service";
import { ChatSearchService } from "./chat-search.service";
import { ChatSummarizeService } from "./chat-summarize.service";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatNotificationsService } from "./chat-notifications.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import type { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { AblyService } from "../realtime/ably.service";
import type { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { ExternalEffectLedger } from "../../common/outbox/external-effect-ledger";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// ChatPresenceService
// ---------------------------------------------------------------------------

describe("ChatPresenceService — tenant isolation", () => {
  function makeDb(rows: unknown[]) {
    const where = jest.fn().mockResolvedValue(rows);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where }),
        }),
      }),
    };
    return { db, where };
  }

  it("DENY: getOnlineUsers binds the where predicate to ATTACKER_ORG and returns no rows", async () => {
    const { db, where } = makeDb([]);
    const service = new ChatPresenceService(db as unknown as Db);

    const result = await service.getOnlineUsers(ATTACKER_ORG);

    const [predicate] = where.mock.calls[0] ?? [];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(result).toEqual([]);
  });

  it("CONTROL: getOnlineUsers binds the where predicate to OWNER_ORG and returns matched users", async () => {
    const now = new Date();
    const mockRow = { userId: "u1", status: "ONLINE", lastSeenAt: now, userName: "Alice", userImage: null };
    const { db, where } = makeDb([mockRow]);
    const service = new ChatPresenceService(db as unknown as Db);

    const result = await service.getOnlineUsers(OWNER_ORG);

    const [predicate] = where.mock.calls[0] ?? [];
    expect(sqlValues(predicate)).toContain(OWNER_ORG);
    expect(result).toHaveLength(1);
    expect((result as typeof mockRow[])[0]).toMatchObject({ userId: "u1" });
  });
});

// ---------------------------------------------------------------------------
// ChatSearchService
// ---------------------------------------------------------------------------

describe("ChatSearchService — tenant isolation", () => {
  function makeDb() {
    let capturedFindManyOptions: Record<string, unknown> | undefined;
    const findMany = jest.fn().mockImplementation((opts: unknown) => {
      capturedFindManyOptions = opts as Record<string, unknown>;
      return Promise.resolve([]);
    });
    const db = {
      execute: jest.fn().mockResolvedValue([]),
      query: { chatMessages: { findMany } },
    } as unknown as Db;
    return { db, findMany, getCaptured: () => capturedFindManyOptions };
  }

  function makeEntities(resolveWith: unknown[] = []) {
    return {
      withResolvedReferences: jest.fn().mockImplementation((_actor: unknown, rows: unknown[]) =>
        Promise.resolve(resolveWith.length ? resolveWith : rows),
      ),
    } as unknown as EntityReferenceService;
  }

  it("DENY: searchMessages binds conditions to ATTACKER_ORG and returns empty results", async () => {
    const { db, getCaptured } = makeDb();
    const service = new ChatSearchService(db, makeEntities());
    const actor = { orgId: ATTACKER_ORG, userId: "user-x" };

    // term length < 3 → skips db.execute, goes straight to findMany
    const result = await service.searchMessages(actor, "hi", 20);

    const opts = getCaptured();
    expect(sqlValues(opts?.where)).toContain(ATTACKER_ORG);
    expect(result.results).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("CONTROL: searchMessages binds conditions to OWNER_ORG and returns found messages", async () => {
    const msgRow = {
      id: 5,
      content: "hello",
      senderId: "u1",
      channelId: 2,
      createdAt: new Date(),
      isDeleted: false,
      sender: { id: "u1", name: "Alice", image: null },
      channel: { id: 2, name: "general", type: "PUBLIC" },
    };

    let capturedOpts: Record<string, unknown> | undefined;
    const findMany = jest.fn().mockImplementation((opts: unknown) => {
      capturedOpts = opts as Record<string, unknown>;
      return Promise.resolve([msgRow]);
    });
    const db = {
      execute: jest.fn().mockResolvedValue([]),
      query: { chatMessages: { findMany } },
    } as unknown as Db;
    const entities = {
      withResolvedReferences: jest.fn().mockImplementation((_actor: unknown, rows: unknown[]) => Promise.resolve(rows)),
    } as unknown as EntityReferenceService;
    const service = new ChatSearchService(db, entities);
    const actor = { orgId: OWNER_ORG, userId: "user-owner" };

    const result = await service.searchMessages(actor, "hi", 20);

    expect(sqlValues(capturedOpts?.where)).toContain(OWNER_ORG);
    expect(result.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ChatSummarizeService
// NOTE: The membership check in assertMember uses channelId + userId only —
// no orgId. A channel member in any org with this channelId passes the check.
// This is a gap: cross-tenant channel access is possible if channelIds collide.
// ---------------------------------------------------------------------------

describe("ChatSummarizeService — tenant isolation", () => {
  it("DENY: summarize throws ForbiddenException when caller is not a channel member", async () => {
    const db = {
      query: {
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as Db;
    const moduleRef = { get: jest.fn() } as unknown as ModuleRef;
    const service = new ChatSummarizeService(db, moduleRef);

    await expect(service.summarize(5, { orgId: ATTACKER_ORG, userId: "user-x" })).rejects.toThrow(ForbiddenException);
    expect(db.query.chatChannelMembers.findFirst).toHaveBeenCalledOnce?.();
  });

  it("CONTROL: summarize returns a summary when caller is a member and AI responds", async () => {
    const limit = jest.fn().mockResolvedValue([
      { id: 1, content: "hello", createdAt: new Date(), senderId: "u1", senderName: "Alice", senderEmail: "a@test.com" },
    ]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });

    const db = {
      query: {
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, channelId: 5, userId: "u1" }),
        },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;

    const invokeText = jest.fn().mockResolvedValue({ ok: true, data: "meeting summary" });
    const moduleRef = { get: jest.fn().mockReturnValue({ invokeText }) } as unknown as ModuleRef;

    const service = new ChatSummarizeService(db, moduleRef);

    const result = await service.summarize(5, { orgId: OWNER_ORG, userId: "u1" });

    expect(result).toEqual({ summary: "meeting summary" });
    expect(invokeText).toHaveBeenCalledOnce?.();
  });
});

// ---------------------------------------------------------------------------
// ChatChannelMembersService
// NOTE: assertMember checks (channelId, userId) only — no orgId. A user
// from a different org can pass the gate if they happen to be in a row with
// the same channelId (possible if numeric channelIds span orgs).
// ---------------------------------------------------------------------------

describe("ChatChannelMembersService — tenant isolation", () => {
  function makeService(findFirstResult: unknown, findManyResult: unknown[] = []) {
    const db = {
      query: {
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue(findFirstResult),
          findMany: jest.fn().mockResolvedValue(findManyResult),
        },
      },
    } as unknown as Db;
    const cache = { invalidateNamespace: jest.fn() } as unknown as CacheService;
    const entities = {} as unknown as EntityReferenceService;
    const service = new ChatChannelMembersService(db, cache, entities);
    return { service, db };
  }

  it("DENY: listMembers throws ForbiddenException when caller is not a channel member", async () => {
    const { service } = makeService(null);

    await expect(service.listMembers(7, "user-attacker")).rejects.toThrow(ForbiddenException);
  });

  it("CONTROL: listMembers returns members when the caller is a valid channel member", async () => {
    const member = { id: 1, channelId: 7, userId: "u1", role: "MEMBER", user: { id: "u1", name: "Alice", image: null, email: "a@t.com" } };
    const { service } = makeService(member, [member]);

    const result = await service.listMembers(7, "u1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ userId: "u1" });
  });
});

// ---------------------------------------------------------------------------
// ChatNotificationsService
// NOTE: publishNewMessageNotification fetches channel members using only
// eq(chatChannelMembers.channelId, channelId) — no orgId filter. This is a
// gap: members of a different org's channel with the same numeric channelId
// would receive notifications.
// ---------------------------------------------------------------------------

describe("ChatNotificationsService — orgId threading", () => {
  function makeService() {
    const where = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;
    const ably = { publishToUser: jest.fn().mockResolvedValue(undefined) } as unknown as AblyService;
    const orgSettings = {
      getSettings: jest.fn().mockResolvedValue({ defaultNotificationPreference: "ALL" }),
    } as unknown as ChatOrgSettingsService;
    const effects = {} as unknown as ExternalEffectLedger;
    const service = new ChatNotificationsService(db, ably, orgSettings, effects);
    return { service, db, ably, where };
  }

  it("DENY: publishNewMessageNotification routes to ATTACKER_ORG's Ably channel, not OWNER_ORG", async () => {
    const { service, where, ably } = makeService();
    where.mockResolvedValue([
      { userId: "u2", mutedUntil: null, notificationPreference: "ALL" },
    ]);

    await service.publishNewMessageNotification(ATTACKER_ORG, 10, { id: 1, senderId: "u1", senderName: "Eve" }, "GROUP");

    expect(ably.publishToUser).toHaveBeenCalledWith(
      ATTACKER_ORG,
      "u2",
      "notification:message",
      expect.any(Object),
    );
  });

  it("CONTROL: publishNewMessageNotification routes to OWNER_ORG's Ably channel", async () => {
    const { service, where, ably } = makeService();
    where.mockResolvedValue([
      { userId: "u3", mutedUntil: null, notificationPreference: "ALL" },
    ]);

    await service.publishNewMessageNotification(OWNER_ORG, 10, { id: 2, senderId: "u1", senderName: "Bob" }, "GROUP");

    expect(ably.publishToUser).toHaveBeenCalledWith(
      OWNER_ORG,
      "u3",
      "notification:message",
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// ChatReplyRemindersService
// NOTE: scheduleForMessage fetches channel members using only
// eq(chatChannelMembers.channelId, channelId) — no orgId filter. This is a
// gap: members from a different org could receive reminders if channelIds collide.
// The inserted reminder rows DO carry orgId, so delivery is bounded.
// ---------------------------------------------------------------------------

describe("ChatReplyRemindersService — tenant isolation", () => {
  function makeDb(memberRows: { userId: string }[]) {
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    });
    const db = {
      query: {
        chatChannelMembers: { findMany: jest.fn().mockResolvedValue(memberRows) },
      },
      update,
      insert,
    } as unknown as Db;
    return { db, insert, values };
  }

  it("DENY: scheduleForMessage inserts no reminders when there are no other channel members", async () => {
    const { db, insert } = makeDb([]);
    const dispatch = {} as unknown as NotificationDispatchService;
    const service = new ChatReplyRemindersService(db, dispatch, { CHAT_REPLY_REMINDER_MINUTES: 15 } as never);

    await service.scheduleForMessage(ATTACKER_ORG, 10, 99, "sender-x");

    expect(insert).not.toHaveBeenCalled();
  });

  it("CONTROL: scheduleForMessage inserts reminders with the caller's orgId for each non-sender member", async () => {
    const { db, insert, values } = makeDb([{ userId: "u2" }]);
    const dispatch = {} as unknown as NotificationDispatchService;
    const service = new ChatReplyRemindersService(db, dispatch, { CHAT_REPLY_REMINDER_MINUTES: 15 } as never);

    await service.scheduleForMessage(OWNER_ORG, 10, 99, "sender-owner");

    expect(insert).toHaveBeenCalledTimes(1);
    const [batch] = values.mock.calls[0] as [{ orgId: string; recipientUserId: string }[]];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ orgId: OWNER_ORG, recipientUserId: "u2", senderUserId: "sender-owner" });
  });
});
