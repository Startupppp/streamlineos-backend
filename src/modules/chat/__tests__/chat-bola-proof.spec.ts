import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatChannelMembersService } from "../chat-channel-members.service";
import { ChatReplyRemindersService } from "../chat-reply-reminders.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { APP_CONFIG } from "../../../config/config.module";

function flatValues(where: unknown, seen = new Set<object>()): unknown[] {
  if (where === null || where === undefined || typeof where !== "object") return [where];
  if (Array.isArray(where)) return where.flatMap((v) => flatValues(v, seen));
  if (seen.has(where as object)) return [];
  seen.add(where as object);
  const rec = where as Record<string, unknown>;
  return [
    ...(Array.isArray(rec.queryChunks) ? flatValues(rec.queryChunks, seen) : []),
    ...("value" in rec ? flatValues(rec.value, seen) : []),
  ];
}

const ORG_OWNER = "org-owner";
const ORG_ATTACKER = "org-attacker";
const USER_OWNER = "user-owner";
const USER_ATTACKER = "user-attacker";
const CHANNEL_ID = 7;
const MESSAGE_ID = 101;

const stubCache = {
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  cachedVersioned: jest.fn().mockResolvedValue([]),
};

const stubEntities = {} as unknown as EntityReferenceService;

beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// ChatChannelMembersService — channel BOLA
// ---------------------------------------------------------------------------

describe("ChatChannelMembersService — channel BOLA", () => {
  function makeDb(overrides: Partial<{
    channelRow: object | null;
    memberRow: object | null;
  }> = {}) {
    const { channelRow = { id: CHANNEL_ID, isArchived: false }, memberRow = { id: 1, userId: USER_OWNER, role: "MEMBER", channelId: CHANNEL_ID } } = overrides;
    return {
      query: {
        chatChannels: { findFirst: jest.fn().mockResolvedValue(channelRow) },
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue(memberRow),
          findMany: jest.fn().mockResolvedValue(memberRow ? [memberRow] : []),
        },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue({ rowCount: 1 }) }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
          }),
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
        }),
      }),
    };
  }

  it("DENY: getChannel returns NotFoundException for an unknown channel — cross-org channel id resolves to null", async () => {
    const db = makeDb({ channelRow: null, memberRow: null });
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);

    await expect(service.getChannel(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER)).rejects.toThrow(NotFoundException);

    const channelCall = db.query.chatChannels.findFirst.mock.calls[0]?.[0];
    expect(flatValues(channelCall?.where)).toContain(ORG_ATTACKER);
  });

  it("DENY: listMembers throws when caller is not a channel member of this org", async () => {
    const db = makeDb({ channelRow: null, memberRow: null });
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);

    await expect(service.listMembers(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER)).rejects.toThrow(NotFoundException);

    const channelCall = db.query.chatChannels.findFirst.mock.calls[0]?.[0];
    expect(flatValues(channelCall?.where)).toContain(ORG_ATTACKER);
  });

  it("DENY: markRead WHERE predicate binds orgId — cannot mark another org's channel read", async () => {
    const db = makeDb();
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);

    await service.markRead(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER);

    const updateCall = db.update.mock.calls[0];
    expect(updateCall).toBeDefined();
    const setCall = (db.update as jest.Mock).mock.results[0]?.value;
    const whereArgs = setCall?.set?.mock?.results?.[0]?.value?.where?.mock?.calls?.[0];
    if (whereArgs) {
      expect(flatValues(whereArgs)).toContain(ORG_ATTACKER);
    }
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: owner org member can mark their channel read", async () => {
    const db = makeDb();
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);

    await service.markRead(CHANNEL_ID, USER_OWNER, ORG_OWNER);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(stubCache.invalidateNamespace).toHaveBeenCalledWith(`chat:unread:${ORG_OWNER}`);
  });

  it("DENY: 404 not 403 when channel does not exist in caller's org (cross-tenant oracle prevention)", async () => {
    const db = makeDb({ channelRow: null, memberRow: null });
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);

    const error = await service.getChannel(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// ChatReplyRemindersService — orgId binding after fix
// ---------------------------------------------------------------------------

describe("ChatReplyRemindersService — orgId in member lookup", () => {
  function makeDb(members: { membershipId: number; membership: { userId: string } }[]) {
    const findMany = jest.fn().mockResolvedValue(members);
    const memberFindFirst = jest.fn().mockResolvedValue({ id: 1 });
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    });
    const db = {
      query: {
        chatChannelMembers: { findMany },
        organizationMembers: { findFirst: memberFindFirst },
      },
      update,
      insert,
    };
    return { db, findMany, memberFindFirst, insert, values };
  }

  const dispatch = {} as unknown as NotificationDispatchService;
  const config = { CHAT_REPLY_REMINDER_MINUTES: 15 };

  it("DENY: scheduleForMessage member lookup binds orgId — attacker org returns no rows", async () => {
    const { db, findMany, memberFindFirst } = makeDb([]);
    const module = await Test.createTestingModule({
      providers: [
        ChatReplyRemindersService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: APP_CONFIG, useValue: config },
      ],
    }).compile();
    const service = module.get(ChatReplyRemindersService);

    await service.scheduleForMessage(ORG_ATTACKER, CHANNEL_ID, MESSAGE_ID, "sender-x");

    const [opts] = findMany.mock.calls[0] ?? [];
    expect(flatValues(opts?.where)).toContain(ORG_ATTACKER);

    const [memberOpts] = memberFindFirst.mock.calls[0] ?? [];
    expect(flatValues(memberOpts?.where)).toContain(ORG_ATTACKER);
  });

  it("CONTROL: scheduleForMessage inserts reminders for OWNER_ORG members only", async () => {
    const { db, findMany, insert, values } = makeDb([
      { membershipId: 2, membership: { userId: "u2" } },
      { membershipId: 3, membership: { userId: "u3" } },
    ]);
    const module = await Test.createTestingModule({
      providers: [
        ChatReplyRemindersService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: APP_CONFIG, useValue: config },
      ],
    }).compile();
    const service = module.get(ChatReplyRemindersService);

    await service.scheduleForMessage(ORG_OWNER, CHANNEL_ID, MESSAGE_ID, "sender-owner");

    const [opts] = findMany.mock.calls[0] ?? [];
    expect(flatValues(opts?.where)).toContain(ORG_OWNER);
    expect(insert).toHaveBeenCalledTimes(1);
    const [batch] = values.mock.calls[0] as [{ orgId: string; recipientUserId: string }[]];
    expect(batch.every((r) => r.orgId === ORG_OWNER)).toBe(true);
    expect(batch).toHaveLength(2);
  });

  it("DENY: a cross-org member list collision cannot schedule reminders for another org", async () => {
    const { db, insert } = makeDb([]);
    const module = await Test.createTestingModule({
      providers: [
        ChatReplyRemindersService,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: APP_CONFIG, useValue: config },
      ],
    }).compile();
    const service = module.get(ChatReplyRemindersService);

    await service.scheduleForMessage(ORG_ATTACKER, CHANNEL_ID, MESSAGE_ID, "sender-x");

    expect(insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-org channel response is 404 not 403 (existence oracle prevention)
// ---------------------------------------------------------------------------

describe("Chat channel existence oracle prevention", () => {
  function makeServiceWithNoChannel() {
    const db = {
      query: {
        chatChannels: { findFirst: jest.fn().mockResolvedValue(null) },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }) }),
    };
    const stubAbly = { publishToUser: jest.fn().mockResolvedValue(undefined) };
    return new ChatChannelMembersService(db as never, stubCache as never, stubEntities, stubAbly as never);
  }

  const cases = [
    ["getChannel", (s: ChatChannelMembersService) => s.getChannel(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER)],
    ["listMembers", (s: ChatChannelMembersService) => s.listMembers(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER)],
  ] as const;

  it.each(cases)("%s returns 404 (not 403) for a cross-org channel id", async (_name, call) => {
    const service = makeServiceWithNoChannel();
    const err = await call(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });
});
