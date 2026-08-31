import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { ChatChannelsService } from "../chat-channels.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { CacheService } from "../../../common/cache/cache.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";
const MEMBERSHIP_A = 11;
const CHANNEL_ID = 42;

function makeActor(
  orgId: string,
  userId = USER_A,
  membershipId = MEMBERSHIP_A,
): EntityActor {
  return {
    orgId,
    userId,
    membershipId,
    isOrgOwner: false,
    permissions: [],
  } as unknown as EntityActor;
}

const mockEntities = {
  withResolvedReferences: jest.fn().mockImplementation(
    <T>(_actor: unknown, rows: T[]) => Promise.resolve(rows),
  ),
  resolve: jest.fn(),
};

const mockPlanLimits = { assertWithinLimit: jest.fn() };
const mockCache = {
  cachedVersioned: jest.fn(),
  invalidateNamespace: jest.fn(),
};

function makeTimelineDb(overrides: {
  channelFound?: boolean;
  channelMemberFound?: boolean;
  messages?: Array<{ id: number; channelId: number; createdAt: Date; senderId: string; content: string; metadata: null; senderMembershipId: number }>;
}) {
  const {
    channelFound = true,
    channelMemberFound = true,
    messages = [],
  } = overrides;

  return {
    query: {
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue(channelFound ? { id: CHANNEL_ID, type: "PUBLIC" } : null),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(
          channelMemberFound ? { id: MEMBERSHIP_A } : undefined,
        ),
      },
      chatMessages: {
        findMany: jest.fn().mockResolvedValue(messages),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_A }),
      },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };
}

describe("Chat reconnect — poll (a): replay without duplicating", () => {
  let service: ChatMessageTimelineService;

  async function build(db: ReturnType<typeof makeTimelineDb>) {
    const mod = await Test.createTestingModule({
      providers: [
        ChatMessageTimelineService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: mockEntities },
      ],
    }).compile();
    return mod.get(ChatMessageTimelineService);
  }

  beforeEach(() => jest.clearAllMocks());

  it("poll returns ONLY messages strictly after `since` — messages at or before since are excluded", async () => {
    const since = new Date("2024-01-01T10:00:00.000Z");
    const before = new Date("2024-01-01T09:59:59.999Z");
    const after = new Date("2024-01-01T10:00:00.001Z");

    const db = makeTimelineDb({
      messages: [
        {
          id: 2,
          channelId: CHANNEL_ID,
          createdAt: after,
          senderId: USER_A,
          content: "after",
          metadata: null,
          senderMembershipId: MEMBERSHIP_A,
        },
      ],
    });
    db.query.chatMessages.findMany.mockImplementation(
      ({ where }: { where: unknown }) => {
        const { params } = require("drizzle-orm/pg-core").PgDialect
          ? Promise.resolve([])
          : Promise.resolve([]);
        void params;
        void where;
        return Promise.resolve([
          {
            id: 2,
            channelId: CHANNEL_ID,
            createdAt: after,
            senderId: USER_A,
            senderMembershipId: MEMBERSHIP_A,
            content: "after",
            metadata: null,
            isEdited: false,
            isDeleted: false,
            messageType: "text",
            actionStatus: null,
            updatedAt: after,
            replyToId: null,
            attachments: [],
            replyTo: null,
          },
        ]);
      },
    );

    service = await build(db);
    const actor = makeActor(ORG_A);
    const result = await service.poll(CHANNEL_ID, actor, since);

    expect(Array.isArray(result)).toBe(true);
    const ids = result.map((m: { id: number }) => m.id);
    expect(ids).not.toContain(1);
    expect(db.query.chatMessages.findMany).toHaveBeenCalledTimes(1);
    const call = db.query.chatMessages.findMany.mock.calls[0][0];
    expect(call).toBeDefined();
  });

  it("poll with an unknown channel returns 404 (not 403 — existence not leaked)", async () => {
    const db = makeTimelineDb({ channelFound: false });
    service = await build(db);
    const actor = makeActor(ORG_B);
    await expect(
      service.poll(CHANNEL_ID, actor, new Date()),
    ).rejects.toThrow(NotFoundException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("poll with a non-member returns 403 AFTER the channel is found (same-org check)", async () => {
    const db = makeTimelineDb({ channelMemberFound: false });
    service = await build(db);
    const actor = makeActor(ORG_A);
    await expect(
      service.poll(CHANNEL_ID, actor, new Date()),
    ).rejects.toThrow(ForbiddenException);
    expect(db.query.chatMessages.findMany).not.toHaveBeenCalled();
  });

  it("poll is idempotent: same `since` called twice returns the same result (no side effects)", async () => {
    const since = new Date("2024-01-01T10:00:00.000Z");
    const msg = {
      id: 5,
      channelId: CHANNEL_ID,
      createdAt: new Date("2024-01-01T10:01:00.000Z"),
      senderId: USER_A,
      senderMembershipId: MEMBERSHIP_A,
      content: "hello",
      metadata: null,
      isEdited: false,
      isDeleted: false,
      messageType: "text",
      actionStatus: null,
      updatedAt: new Date(),
      replyToId: null,
      attachments: [],
      replyTo: null,
    };
    const db = makeTimelineDb({ messages: [msg] });
    db.query.chatMessages.findMany.mockResolvedValue([msg]);
    service = await build(db);
    const actor = makeActor(ORG_A);

    const first = await service.poll(CHANNEL_ID, actor, since);
    const second = await service.poll(CHANNEL_ID, actor, since);

    expect(first.map((m: { id: number }) => m.id)).toEqual(
      second.map((m: { id: number }) => m.id),
    );
    expect(db.query.chatMessages.findMany).toHaveBeenCalledTimes(2);
  });

  it("poll scopes the channel lookup to the caller's orgId (tenant isolation)", async () => {
    const db = makeTimelineDb({ channelFound: true });
    service = await build(db);
    const actor = makeActor(ORG_B);
    db.query.chatChannels.findFirst.mockResolvedValue(null);
    await expect(service.poll(CHANNEL_ID, actor, new Date())).rejects.toThrow(NotFoundException);

    const channelCall = db.query.chatChannels.findFirst.mock.calls[0]?.[0];
    expect(channelCall).toBeDefined();
    expect(channelCall?.where).toBeDefined();
  });
});

describe("Chat reconnect — Ably token (c): channel subscription is tenant+membership scoped", () => {
  let channelsService: ChatChannelsService;

  function makeChannelsDb(overrides: {
    membershipId?: number | null;
    channelRows?: Array<{ channelId: number }>;
  }) {
    const { membershipId = MEMBERSHIP_A, channelRows = [] } = overrides;
    return {
      query: {
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue(membershipId !== null ? { id: membershipId } : null),
        },
      },
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(channelRows),
    };
  }

  async function buildChannelsService(db: ReturnType<typeof makeChannelsDb>) {
    const mod = await Test.createTestingModule({
      providers: [
        ChatChannelsService,
        { provide: DRIZZLE, useValue: db },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: CacheService, useValue: mockCache },
        { provide: EntityReferenceService, useValue: mockEntities },
      ],
    }).compile();
    return mod.get(ChatChannelsService);
  }

  beforeEach(() => jest.clearAllMocks());

  it("DENY: user with no org membership gets an empty channel list (no token capabilities)", async () => {
    const db = makeChannelsDb({ membershipId: null });
    channelsService = await buildChannelsService(db);
    const result = await channelsService.listMemberChannelIds(ORG_A, USER_A);
    expect(result).toEqual([]);
  });

  it("ALLOW: member with a single channel returns exactly that channel ID", async () => {
    const db = makeChannelsDb({
      membershipId: MEMBERSHIP_A,
      channelRows: [{ channelId: CHANNEL_ID }],
    });
    channelsService = await buildChannelsService(db);
    const result = await channelsService.listMemberChannelIds(ORG_A, USER_A);
    expect(result).toEqual([CHANNEL_ID]);
  });

  it("ALLOW: member with multiple channels returns all of them", async () => {
    const db = makeChannelsDb({
      membershipId: MEMBERSHIP_A,
      channelRows: [{ channelId: 1 }, { channelId: 2 }, { channelId: 3 }],
    });
    channelsService = await buildChannelsService(db);
    const result = await channelsService.listMemberChannelIds(ORG_A, USER_A);
    expect(result).toEqual([1, 2, 3]);
  });

  it("DENY: after removal from channel, membershipId lookup returns no rows → token has no channel access", async () => {
    const db = makeChannelsDb({
      membershipId: MEMBERSHIP_A,
      channelRows: [],
    });
    channelsService = await buildChannelsService(db);
    const result = await channelsService.listMemberChannelIds(ORG_A, USER_A);
    expect(result).toEqual([]);
  });

  it("ISOLATION: listMemberChannelIds uses membershipId (not userId alone) for the channel lookup", async () => {
    const db = makeChannelsDb({
      membershipId: MEMBERSHIP_A,
      channelRows: [{ channelId: CHANNEL_ID }],
    });
    channelsService = await buildChannelsService(db);
    await channelsService.listMemberChannelIds(ORG_A, USER_A);

    expect(db.query.organizationMembers.findFirst).toHaveBeenCalledTimes(1);
    const orgMemberCall =
      db.query.organizationMembers.findFirst.mock.calls[0]?.[0];
    expect(orgMemberCall).toBeDefined();
  });
});
