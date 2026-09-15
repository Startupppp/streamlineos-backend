import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import { ChatChannelMemberState } from "../chat-channel-member-state";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { ChatReplyRemindersService } from "../chat-reply-reminders.service";
import { ChatSavedService } from "../chat-saved.service";
import { ChatSavedController } from "../chat-saved.controller";
import { ChatPinsController } from "../chat-pins.controller";
import { ChatSearchController } from "../chat-search.controller";
import { searchMessagesQuerySchema } from "../dto/chat-search.schemas";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { APP_CONFIG } from "../../../config/config.module";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

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

const attackerActor: EntityActor = {
  orgId: ORG_ATTACKER,
  userId: USER_ATTACKER,
  membershipId: 1,
  isOrgOwner: false,
};
const ownerActor: EntityActor = {
  orgId: ORG_OWNER,
  userId: USER_OWNER,
  membershipId: 2,
  isOrgOwner: false,
};
const CHANNEL_ID = 7;
const MESSAGE_ID = 101;

const stubEntities = {} as unknown as EntityReferenceService;

beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// ChatChannelMembersImplementation / ChatChannelMemberState — channel BOLA
// ---------------------------------------------------------------------------

describe("ChatChannelMembersImplementation — channel BOLA", () => {
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
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);

    await expect(service.getChannel(CHANNEL_ID, attackerActor)).rejects.toThrow(NotFoundException);

    const channelCall = db.query.chatChannels.findFirst.mock.calls[0]?.[0];
    expect(flatValues(channelCall?.where)).toContain(ORG_ATTACKER);
  });

  it("DENY: listMembers throws when caller is not a channel member of this org", async () => {
    const db = makeDb({ channelRow: null, memberRow: null });
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);

    await expect(service.listMembers(CHANNEL_ID, attackerActor)).rejects.toThrow(NotFoundException);

    const channelCall = db.query.chatChannels.findFirst.mock.calls[0]?.[0];
    expect(flatValues(channelCall?.where)).toContain(ORG_ATTACKER);
  });

  it("DENY: markRead WHERE predicate binds orgId — cannot mark another org's channel read", async () => {
    const db = makeDb();
    const state = new ChatChannelMemberState(db as never);

    await state.markRead(CHANNEL_ID, USER_ATTACKER, ORG_ATTACKER);

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
    const state = new ChatChannelMemberState(db as never);

    await state.markRead(CHANNEL_ID, USER_OWNER, ORG_OWNER);

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("DENY: 404 not 403 when channel does not exist in caller's org (cross-tenant oracle prevention)", async () => {
    const db = makeDb({ channelRow: null, memberRow: null });
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);

    const error = await service.getChannel(CHANNEL_ID, attackerActor).catch((e: unknown) => e);
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
    return new ChatChannelMembersImplementation(db as never, stubEntities);
  }

  const cases = [
    ["getChannel", (s: ChatChannelMembersImplementation) => s.getChannel(CHANNEL_ID, attackerActor)],
    ["listMembers", (s: ChatChannelMembersImplementation) => s.listMembers(CHANNEL_ID, attackerActor)],
  ] as const;

  it.each(cases)("%s returns 404 (not 403) for a cross-org channel id", async (_name, call) => {
    const service = makeServiceWithNoChannel();
    const err = await call(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Private channel non-member gets 404 not 403 (existence oracle prevention)
// ---------------------------------------------------------------------------

describe("Private channel non-member BOLA", () => {
  const MEMBERSHIP_ID = 42;

  function makeDb(isPrivate: boolean, isMember: boolean) {
    return {
      query: {
        chatChannels: {
          findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, isPrivate }),
        },
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue(isMember ? { role: "MEMBER" } : null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID }),
        },
      },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }) }),
    };
  }

  it("DENY: private channel non-member → 404 (not 403)", async () => {
    const db = makeDb(true, false);
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);
    const err = await service.getChannel(CHANNEL_ID, attackerActor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });

  it("DENY: public channel non-member → 403 (membership enforced, channel existence ok to reveal)", async () => {
    const db = makeDb(false, false);
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);
    const err = await service.getChannel(CHANNEL_ID, attackerActor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("CONTROL: private channel member → resolves without error", async () => {
    const db = makeDb(true, true);
    (db.query.chatChannels.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: CHANNEL_ID, isPrivate: true })
      .mockResolvedValueOnce({ id: CHANNEL_ID, isPrivate: true, name: "secret", type: "GROUP", members: [] });
    const service = new ChatChannelMembersImplementation(db as never, stubEntities);
    const result = await service.getChannel(CHANNEL_ID, ownerActor);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ChatSavedService — legacy fallback path is unreachable
// ---------------------------------------------------------------------------

describe("ChatSavedService — the saved list is keyed on membership, never on user id", () => {
  const MEMBERSHIP_ID = 9;
  const MSG_ID = 200;
  const ACTOR = { orgId: ORG_OWNER, userId: USER_OWNER, membershipId: MEMBERSHIP_ID, isOrgOwner: false };
  const ACTOR_NO_MEMBERSHIP = { orgId: ORG_OWNER, userId: USER_OWNER, isOrgOwner: false };

  function makeDb() {
    const findFirstSaved = jest.fn().mockResolvedValue(null);
    const findManySaved = jest.fn().mockResolvedValue([]);
    const findFirstMsg = jest.fn().mockResolvedValue({ id: MSG_ID, channelId: CHANNEL_ID, orgId: ORG_OWNER });
    const findFirstChanMember = jest.fn().mockResolvedValue({ role: "MEMBER" });
    const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ messageId: MSG_ID }]) });
    const deleteFn = jest.fn().mockReturnValue({ where: deleteWhere });
    const insertValues = jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) });
    const insertFn = jest.fn().mockReturnValue({ values: insertValues });
    const db = {
      query: {
        chatSavedMessages: { findFirst: findFirstSaved, findMany: findManySaved },
        chatMessages: { findFirst: findFirstMsg },
        chatChannelMembers: { findFirst: findFirstChanMember },
      },
      delete: deleteFn,
      insert: insertFn,
    };
    return { db, findFirstSaved, findManySaved, deleteWhere, insertValues, insertFn };
  }

  const stubEntityRef = { withResolvedReferences: jest.fn().mockResolvedValue([]) } as unknown as EntityReferenceService;

  it("list() binds the membership the actor carries and never the user id", async () => {
    const { db, findManySaved } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await service.list(ACTOR);
    const [opts] = findManySaved.mock.calls[0] ?? [];
    const values = flatValues(opts?.where);
    expect(values).toContain(MEMBERSHIP_ID);
    expect(values).not.toContain(USER_OWNER);
  });

  it("list() reads nothing at all for an actor with no membership", async () => {
    const { db, findManySaved } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await expect(service.list(ACTOR_NO_MEMBERSHIP)).resolves.toEqual({ items: [], nextCursor: undefined });
    expect(findManySaved).not.toHaveBeenCalled();
  });

  it("save() stores the membership id, not only the user id", async () => {
    const { db, insertValues } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await expect(service.save(ACTOR, MSG_ID)).resolves.toEqual({ ok: true });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ membershipId: MEMBERSHIP_ID }));
  });

  it("save() refuses an actor with no membership and writes nothing", async () => {
    const { db, insertFn } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await expect(service.save(ACTOR_NO_MEMBERSHIP, MSG_ID)).rejects.toThrow(ForbiddenException);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("unsave() DELETE WHERE binds membershipId, not userId", async () => {
    const { db, deleteWhere } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await service.unsave(ACTOR, MSG_ID);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const [whereArg] = deleteWhere.mock.calls[0] ?? [];
    const values = flatValues(whereArg);
    expect(values).toContain(MEMBERSHIP_ID);
    expect(values).not.toContain(USER_OWNER);
  });

  it("isSaved() query binds membershipId, not userId", async () => {
    const { db, findFirstSaved } = makeDb();
    const service = new ChatSavedService(db as never, stubEntityRef);
    await service.isSaved(ACTOR, MSG_ID);
    const [opts] = findFirstSaved.mock.calls[0] ?? [];
    const values = flatValues(opts?.where);
    expect(values).toContain(MEMBERSHIP_ID);
    expect(values).not.toContain(USER_OWNER);
  });
});

describe("Chat controllers hand the service an actor that carries the membership", () => {
  const MEMBERSHIP_ID = 9;

  function currentUser(): CurrentUserContext {
    return {
      userId: USER_OWNER,
      orgId: ORG_OWNER,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
    };
  }

  it("ChatSavedController.save passes membershipId through — without it every save is a 403", () => {
    const saved = { save: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new ChatSavedController(saved as never);
    controller.save(200, currentUser());
    expect(saved.save).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: MEMBERSHIP_ID }),
      200,
    );
  });

  it("ChatSavedController.list passes membershipId through — without it the list is always empty", () => {
    const saved = { list: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }) };
    const controller = new ChatSavedController(saved as never);
    // The controller now takes the zod-parsed query object rather than two raw strings:
    // `?limit=abc` used to reach the database as NaN, and drizzle drops a NaN `limit`
    // clause instead of erroring, so the saved list became an unbounded read.
    // `pageSizeField(30, 100)` supplies the 30 when `limit` is absent.
    controller.list({ cursor: undefined, limit: 30 }, currentUser());
    expect(saved.list).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: MEMBERSHIP_ID }),
      undefined,
      30,
    );
  });

  it("ChatPinsController.pin passes membershipId through — without it every pin is a 403", () => {
    const pins = { pin: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new ChatPinsController(pins as never);
    controller.pin(CHANNEL_ID, { messageId: MESSAGE_ID }, currentUser());
    expect(pins.pin).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ membershipId: MEMBERSHIP_ID }),
    );
  });

  it("ChatSearchController.searchMessages passes membershipId through — without it search returns nothing", () => {
    const search = { searchMessages: jest.fn().mockResolvedValue({ results: [], nextCursor: undefined }) };
    const controller = new ChatSearchController(search as never);
    // Parse through the real schema rather than hand-building the query: the page
    // size default is the schema's, and a hand-built object silently loses it.
    controller.searchMessages(searchMessagesQuerySchema.parse({ q: "hello" }), currentUser());
    expect(search.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: MEMBERSHIP_ID }),
      "hello",
      20,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Departed-member display: null senderMembershipId renders gracefully
// After the actor cutover, senderId is dropped. Identity resolves only via
// senderMembership.userId; a null senderMembershipId yields a null sender,
// never a crash.
// ---------------------------------------------------------------------------

describe("Departed-member display: null senderMembershipId renders gracefully", () => {
  it("a null senderMembershipId produces a null sender identity without throwing", () => {
    const rows: Array<{ senderMembership: { userId: string } | null; content: string }> = [
      { senderMembership: null, content: "hello from the past" },
    ];
    const senderIds = new Set<string>();
    for (const r of rows)
      if (r.senderMembership?.userId) senderIds.add(r.senderMembership.userId);
    expect(senderIds.size).toBe(0);
  });

  it("a populated senderMembership yields a userId for identity resolution", () => {
    const rows: Array<{ senderMembership: { userId: string } | null; content: string }> = [
      { senderMembership: { userId: "user-a" }, content: "hi" },
    ];
    const senderIds = new Set<string>();
    for (const r of rows)
      if (r.senderMembership?.userId) senderIds.add(r.senderMembership.userId);
    expect([...senderIds]).toEqual(["user-a"]);
  });
});

// ---------------------------------------------------------------------------
// ChatMessageTimelineService — thread (reply-chain) BOLA
// A non-member of a channel must not be able to read messages (or reply threads)
// in that channel, regardless of whether the channel is in the same org.
// ---------------------------------------------------------------------------

describe("ChatMessageTimelineService — thread BOLA", () => {
  const MEMBERSHIP_ID = 11;

  function makeActor(orgId: string, membershipId?: number): EntityActor {
    return { orgId, userId: USER_ATTACKER, membershipId, isOrgOwner: false, permissions: [] } as unknown as EntityActor;
  }

  function makeTimelineDb(channelFound: boolean, channelType: string, isMember: boolean) {
    return {
      query: {
        chatChannels: {
          findFirst: jest.fn().mockResolvedValue(channelFound ? { id: CHANNEL_ID, type: channelType } : null),
        },
        chatChannelMembers: {
          findFirst: jest.fn().mockResolvedValue(isMember ? { id: MEMBERSHIP_ID } : undefined),
        },
        chatMessages: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID }),
        },
      },
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    };
  }

  function makeStubEntityRef() {
    return { withResolvedReferences: jest.fn().mockImplementation((_a: unknown, rows: unknown[]) => Promise.resolve(rows)), resolve: jest.fn() } as unknown as EntityReferenceService;
  }

  async function buildTimeline(db: ReturnType<typeof makeTimelineDb>, entityRef: EntityReferenceService): Promise<ChatMessageTimelineService> {
    const mod = await Test.createTestingModule({
      providers: [
        ChatMessageTimelineService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: entityRef },
      ],
    }).compile();
    return mod.get(ChatMessageTimelineService);
  }

  it("DENY: poll returns 404 for a channel that does not exist in the caller's org (cross-org BOLA)", async () => {
    const db = makeTimelineDb(false, "GROUP", false);
    const svc = await buildTimeline(db, makeStubEntityRef());
    await expect(svc.poll(CHANNEL_ID, makeActor(ORG_ATTACKER, MEMBERSHIP_ID), new Date(), undefined, 50)).rejects.toThrow(NotFoundException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("DENY: poll returns 403 for a public-channel non-member (thread BOLA — existence known, access denied)", async () => {
    const db = makeTimelineDb(true, "PUBLIC", false);
    const svc = await buildTimeline(db, makeStubEntityRef());
    await expect(svc.poll(CHANNEL_ID, makeActor(ORG_OWNER, MEMBERSHIP_ID), new Date(), undefined, 50)).rejects.toThrow(ForbiddenException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("DENY: poll returns 404 for a private-channel non-member (thread BOLA — existence concealed)", async () => {
    const db = makeTimelineDb(true, "GROUP", false);
    const svc = await buildTimeline(db, makeStubEntityRef());
    await expect(svc.poll(CHANNEL_ID, makeActor(ORG_OWNER, MEMBERSHIP_ID), new Date(), undefined, 50)).rejects.toThrow(NotFoundException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("DENY: poll returns 403 when caller has no membershipId (not org member, public channel)", async () => {
    const db = makeTimelineDb(true, "PUBLIC", false);
    const svc = await buildTimeline(db, makeStubEntityRef());
    await expect(svc.poll(CHANNEL_ID, makeActor(ORG_OWNER, undefined), new Date(), undefined, 50)).rejects.toThrow(ForbiddenException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("ALLOW: channel member can poll and receives a paginated result with messages array", async () => {
    const db = makeTimelineDb(true, "GROUP", true);
    const svc = await buildTimeline(db, makeStubEntityRef());
    const result = await svc.poll(CHANNEL_ID, makeActor(ORG_OWNER, MEMBERSHIP_ID), new Date("2020-01-01"), undefined, 50);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result).toHaveProperty("hasMore");
  });
});
