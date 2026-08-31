import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatSavedService } from "./chat-saved.service";
import { ChatMessagesService } from "./chat-messages.service";
import { CacheService } from "../../common/cache/cache.service";
import { AblyService } from "../realtime/ably.service";
import { ChatReplyRemindersService } from "./chat-reply-reminders.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { MESSAGE_FANOUT_PROVIDER } from "./message-fanout.interface";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import { WebPushService } from "../realtime/web-push.service";
import { AuditService } from "../../common/audit/audit.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (!isRecord(value) || seen.has(value)) return [];

  seen.add(value);
  const queryChunks = value.queryChunks;
  const nestedValue = value.value;
  return [
    ...(Array.isArray(queryChunks) ? sqlValues(queryChunks, seen) : []),
    ...(Object.hasOwn(value, "value") ? sqlValues(nestedValue, seen) : []),
  ];
}

describe("Chat mutation services — cross-tenant isolation", () => {
  const actor = { orgId: "org-attacker", userId: "user-attacker", isOrgOwner: false };

  it("ChatPinsService binds membership to the actor organization and denies before pin mutation", async () => {
    const actorWithMembership = { ...actor, membershipId: 99 };
    const db = {
      query: {
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        chatMessages: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatPinsService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatPinsService);

    await expect(service.pin(27, 91, actorWithMembership)).rejects.toThrow(ForbiddenException);

    const membershipQuery = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(membershipQuery?.where)).toContain(actor.orgId);
    expect(sqlValues(membershipQuery?.where)).toContain(actorWithMembership.membershipId);
    expect(db.query.chatMessages.findFirst).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("ChatSavedService binds the target message to the actor organization and denies before save mutation", async () => {
    const db = {
      query: {
        chatMessages: { findFirst: jest.fn().mockResolvedValue(undefined) },
        chatChannelMembers: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatSavedService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatSavedService);

    await expect(service.save(actor, 91)).rejects.toThrow(NotFoundException);

    const messageQuery = db.query.chatMessages.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(messageQuery?.where)).toContain(actor.orgId);
    expect(db.query.chatChannelMembers.findFirst).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("ChatMessagesService — cross-tenant isolation on edit and remove", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeMessagesService(messageRow: unknown) {
    const db = {
      query: {
        chatMessages: { findFirst: jest.fn().mockResolvedValue(messageRow) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
    };
    return { db };
  }

  it("DENY: edit binds message lookup to actor orgId (cross-tenant probe returns NotFoundException)", async () => {
    const { db } = makeMessagesService(null);

    const module = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: {} },
        { provide: AblyService, useValue: {} },
        { provide: ChatReplyRemindersService, useValue: {} },
        { provide: ChatOrgSettingsService, useValue: {} },
        { provide: EntityReferenceService, useValue: {} },
        { provide: MESSAGE_FANOUT_PROVIDER, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatMessagesService);

    await expect(service.edit(99, "user-x", ATTACKER_ORG, "pwned")).rejects.toThrow(NotFoundException);

    const q = db.query.chatMessages.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(q?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(q?.where)).not.toContain(OWNER_ORG);
  });

  it("CONTROL: edit proceeds when message belongs to actor orgId", async () => {
    const msgRow = { id: 99, orgId: OWNER_ORG, channelId: 1, senderId: "u1", senderMembershipId: 5, isDeleted: false };
    const { db } = makeMessagesService(msgRow);
    db.query.organizationMembers.findFirst.mockResolvedValue({ id: 5 });
    db.query.chatChannelMembers.findFirst.mockResolvedValue({ id: 1 });

    const module = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: {} },
        { provide: AblyService, useValue: { publishChatEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: ChatReplyRemindersService, useValue: {} },
        { provide: ChatOrgSettingsService, useValue: {} },
        { provide: EntityReferenceService, useValue: {} },
        { provide: MESSAGE_FANOUT_PROVIDER, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatMessagesService);

    const result = await service.edit(99, "u1", OWNER_ORG, "updated");

    const q = db.query.chatMessages.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(q?.where)).toContain(OWNER_ORG);
    expect(result).toEqual({ ok: true });
  });

  it("DENY: remove binds message lookup to actor orgId (cross-tenant probe returns NotFoundException)", async () => {
    const { db } = makeMessagesService(null);

    const module = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: {} },
        { provide: AblyService, useValue: {} },
        { provide: ChatReplyRemindersService, useValue: {} },
        { provide: ChatOrgSettingsService, useValue: {} },
        { provide: EntityReferenceService, useValue: {} },
        { provide: MESSAGE_FANOUT_PROVIDER, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatMessagesService);

    await expect(service.remove(99, "user-x", false, ATTACKER_ORG)).rejects.toThrow(NotFoundException);

    const q = db.query.chatMessages.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(q?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(q?.where)).not.toContain(OWNER_ORG);
  });
});

describe("ChatHuddlesService — cross-tenant isolation on huddle operations", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeHuddlesService(huddleRow: unknown) {
    const db = {
      query: {
        chatHuddles: { findFirst: jest.fn().mockResolvedValue(huddleRow) },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        chatChannels: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
        chatHuddleParticipants: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    return { db };
  }

  it("DENY: joinHuddle returns NotFoundException when orgId does not match (cross-tenant probe)", async () => {
    const { db } = makeHuddlesService(null);

    const module = await Test.createTestingModule({
      providers: [
        ChatHuddlesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: {} },
        { provide: WebPushService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: ChatOrgSettingsService, useValue: {} },
        { provide: PlanLimitsService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatHuddlesService);

    await expect(service.joinHuddle(42, "user-x", ATTACKER_ORG)).rejects.toThrow(NotFoundException);

    const q = db.query.chatHuddles.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(q?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(q?.where)).not.toContain(OWNER_ORG);
  });

  it("DENY: heartbeat binds update to actor orgId — cross-org participant cannot be kept alive", async () => {
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ChatHuddleSignalsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatHuddleSignalsService);

    await service.heartbeat(42, "user-x", ATTACKER_ORG);

    const whereCall = (db.update as jest.Mock).mock.results[0]?.value.set.mock.results[0]?.value.where;
    const [predicate] = (whereCall as jest.Mock).mock.calls[0] ?? [];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("CONTROL: heartbeat with matching orgId updates the participant row", async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: whereMock }),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ChatHuddleSignalsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatHuddleSignalsService);

    const result = await service.heartbeat(42, "user-owner", OWNER_ORG);

    expect(result).toEqual({ ok: true });
    expect(whereMock).toHaveBeenCalledTimes(1);
    const [predicate] = whereMock.mock.calls[0] ?? [];
    expect(sqlValues(predicate)).toContain(OWNER_ORG);
  });
});
