import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { ChatChannelListService } from "../chat-channel-list.service";
import { ChatChannelsService } from "../chat-channels.service";

const dialect = new PgDialect();
const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";
const MEMBERSHIP_A = 11;
const MEMBERSHIP_OTHER = 99;
const CHANNEL_ID = 42;
const OTHER_CHANNEL_ID = 77;
const SINCE = new Date("2024-05-01T10:00:00.000Z");

function actorIn(orgId: string): EntityActor {
  return { orgId, userId: USER_A, membershipId: MEMBERSHIP_A, isOrgOwner: false };
}

function bound(where: SQL, table: string, column: string, operator: "=" | ">"): unknown {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const match = new RegExp(`"${table}"\\."${column}"\\s*${operator}\\s*\\$(\\d+)`, "i").exec(text);
  return match ? params[Number(match[1]) - 1] : undefined;
}

// A predicate the service never emitted filters nothing, so a removed WHERE clause surfaces as a leaked row.
function keeps(actual: string | number | boolean, expected: unknown): boolean {
  return expected === undefined || actual === expected;
}

interface ChannelFixture {
  id: number;
  orgId: string;
  type: "PUBLIC" | "PRIVATE";
}

interface MemberFixture {
  orgId: string;
  channelId: number;
  membershipId: number;
}

interface MessageFixture {
  id: number;
  orgId: string;
  channelId: number;
  channelPosition: number;
  createdAt: Date;
  content: string;
  isDeleted: boolean;
  metadata: Record<string, unknown> | null;
  senderMembership: null;
  replyTo: null;
  reactions: [];
  attachments: [];
}

function message(position: number, createdAt: Date): MessageFixture {
  return {
    id: position,
    orgId: ORG_A,
    channelId: CHANNEL_ID,
    channelPosition: position,
    createdAt,
    content: `m${position}`,
    isDeleted: false,
    metadata: null,
    senderMembership: null,
    replyTo: null,
    reactions: [],
    attachments: [],
  };
}

interface PollRead {
  readonly above: number | undefined;
  readonly since: Date | undefined;
}

interface PollWorld {
  channels: ChannelFixture[];
  members: MemberFixture[];
  messages: MessageFixture[];
}

function pollRead(where: SQL): PollRead {
  const above = bound(where, "chat_messages", "channel_position", ">");
  const since = bound(where, "chat_messages", "created_at", ">");
  if (since !== undefined && typeof since !== "string")
    throw new Error(`the since bound reached the driver as ${typeof since}`);
  return {
    above: typeof above === "number" ? above : undefined,
    since: typeof since === "string" ? new Date(since) : undefined,
  };
}

interface PollHarness {
  readonly service: ChatMessageTimelineService;
  readonly reads: PollRead[];
}

async function buildPollHarness(world: PollWorld): Promise<PollHarness> {
  const reads: PollRead[] = [];

  const db = {
    query: {
      chatChannels: {
        findFirst: jest.fn(({ where }: { where: SQL }) => {
          const id = bound(where, "chat_channels", "id", "=");
          const orgId = bound(where, "chat_channels", "org_id", "=");
          return Promise.resolve(
            world.channels.find((c) => keeps(c.id, id) && keeps(c.orgId, orgId)),
          );
        }),
      },
      chatChannelMembers: {
        findFirst: jest.fn(({ where }: { where: SQL }) => {
          const orgId = bound(where, "chat_channel_members", "org_id", "=");
          const channelId = bound(where, "chat_channel_members", "channel_id", "=");
          const membershipId = bound(where, "chat_channel_members", "membership_id", "=");
          return Promise.resolve(
            world.members.find(
              (m) =>
                keeps(m.orgId, orgId) &&
                keeps(m.channelId, channelId) &&
                keeps(m.membershipId, membershipId),
            ),
          );
        }),
      },
      chatMessages: {
        findMany: jest.fn(({ where, limit }: { where: SQL; limit: number }) => {
          const read = pollRead(where);
          reads.push(read);
          const rows = world.messages
            .filter((row) => read.above === undefined || row.channelPosition > read.above)
            .filter((row) => read.since === undefined || row.createdAt > read.since)
            .sort((a, b) => a.channelPosition - b.channelPosition)
            .slice(0, limit);
          return Promise.resolve(rows);
        }),
      },
    },
  };

  const entities = {
    withResolvedReferences: jest.fn((_actor: EntityActor, rows: unknown[]) => Promise.resolve(rows)),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatMessageTimelineService,
      { provide: DRIZZLE, useValue: db },
      { provide: EntityReferenceService, useValue: entities },
    ],
  }).compile();

  return { service: moduleRef.get(ChatMessageTimelineService), reads };
}

function publicWorld(messages: MessageFixture[]): PollWorld {
  return {
    channels: [{ id: CHANNEL_ID, orgId: ORG_A, type: "PUBLIC" }],
    members: [{ orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_A }],
    messages,
  };
}

describe("chat poll — the `since` filter is emitted and bites", () => {
  it("binds created_at > the instant the client last saw when no cursor is supplied", async () => {
    const harness = await buildPollHarness(publicWorld([]));

    await harness.service.poll(CHANNEL_ID, actorIn(ORG_A), SINCE, undefined, 50);

    expect(harness.reads[0]?.since?.toISOString()).toBe(SINCE.toISOString());
    expect(harness.reads[0]?.above).toBeUndefined();
  });

  it("replays the message a millisecond after `since`, not the one stamped exactly at it", async () => {
    const before = message(1, new Date(SINCE.getTime() - 1));
    const exactly = message(2, SINCE);
    const after = message(3, new Date(SINCE.getTime() + 1));
    const harness = await buildPollHarness(publicWorld([before, exactly, after]));

    const result = await harness.service.poll(CHANNEL_ID, actorIn(ORG_A), SINCE, undefined, 50);

    expect(result.messages.map((m) => m.id)).toEqual([after.id]);
  });

  it("bounds a reconnect carrying a cursor by position alone, so an older message ahead of it still replays", async () => {
    const stale = message(2, new Date(SINCE.getTime() - 60_000));
    const fresh = message(3, new Date(SINCE.getTime() + 60_000));
    const harness = await buildPollHarness(
      publicWorld([message(1, new Date(SINCE.getTime() - 120_000)), stale, fresh]),
    );

    const result = await harness.service.poll(CHANNEL_ID, actorIn(ORG_A), SINCE, 1, 50);

    expect(harness.reads[0]?.above).toBe(1);
    expect(harness.reads[0]?.since).toBeUndefined();
    expect(result.messages.map((m) => m.id)).toEqual([stale.id, fresh.id]);
  });
});

describe("chat poll — the denial follows from the rows, not from the double", () => {
  it("answers 404 for a channel that exists in another organization, and reads no messages", async () => {
    const harness = await buildPollHarness(publicWorld([message(1, SINCE)]));

    await expect(
      harness.service.poll(CHANNEL_ID, actorIn(ORG_B), SINCE, undefined, 50),
    ).rejects.toThrow(NotFoundException);
    expect(harness.reads).toHaveLength(0);
  });

  it("answers 403 on a public channel whose only member row belongs to somebody else", async () => {
    const world = publicWorld([message(1, SINCE)]);
    world.members = [
      { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_OTHER },
      { orgId: ORG_A, channelId: OTHER_CHANNEL_ID, membershipId: MEMBERSHIP_A },
    ];
    const harness = await buildPollHarness(world);

    await expect(
      harness.service.poll(CHANNEL_ID, actorIn(ORG_A), SINCE, undefined, 50),
    ).rejects.toThrow(ForbiddenException);
    expect(harness.reads).toHaveLength(0);
  });

  it("answers 404 for that same non-member on a private channel, so the reply confirms nothing", async () => {
    const world = publicWorld([message(1, SINCE)]);
    world.channels = [{ id: CHANNEL_ID, orgId: ORG_A, type: "PRIVATE" }];
    world.members = [{ orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_OTHER }];
    const harness = await buildPollHarness(world);

    await expect(
      harness.service.poll(CHANNEL_ID, actorIn(ORG_A), SINCE, undefined, 50),
    ).rejects.toThrow(NotFoundException);
    expect(harness.reads).toHaveLength(0);
  });
});

interface CapabilityRow {
  orgId: string;
  channelId: number;
  membershipId: number;
  isArchived: boolean;
}

interface MembershipRow {
  id: number;
  orgId: string;
  userId: string;
  status: string;
}

interface CapabilityWorld {
  memberships: MembershipRow[];
  channelMembers: CapabilityRow[];
}

interface SelectChain {
  from(): SelectChain;
  innerJoin(): SelectChain;
  where(condition: SQL): SelectChain;
  limit(count: number): Promise<Array<{ channelId: number }>>;
}

interface CapabilityHarness {
  readonly service: ChatChannelsService;
  readonly select: jest.Mock;
}

async function buildCapabilityHarness(world: CapabilityWorld): Promise<CapabilityHarness> {
  let captured: SQL | undefined;

  const chain: SelectChain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (condition) => {
      captured = condition;
      return chain;
    },
    limit: (count) => {
      if (!captured) throw new Error("the capability read issued no WHERE clause");
      const orgId = bound(captured, "chat_channels", "org_id", "=");
      const membershipId = bound(captured, "chat_channel_members", "membership_id", "=");
      const isArchived = bound(captured, "chat_channels", "is_archived", "=");
      const rows = world.channelMembers
        .filter(
          (row) =>
            keeps(row.orgId, orgId) &&
            keeps(row.membershipId, membershipId) &&
            keeps(row.isArchived, isArchived),
        )
        .slice(0, count)
        .map((row) => ({ channelId: row.channelId }));
      return Promise.resolve(rows);
    },
  };

  const select = jest.fn(() => chain);
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn(({ where }: { where: SQL }) => {
          const orgId = bound(where, "organization_members", "org_id", "=");
          const userId = bound(where, "organization_members", "user_id", "=");
          const status = bound(where, "organization_members", "status", "=");
          return Promise.resolve(
            world.memberships.find(
              (row) =>
                keeps(row.orgId, orgId) && keeps(row.userId, userId) && keeps(row.status, status),
            ),
          );
        }),
      },
    },
    select,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatChannelsService,
      ChatChannelListService,
      { provide: DRIZZLE, useValue: db },
      { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      { provide: CacheService, useValue: { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn() } },
      { provide: EntityReferenceService, useValue: { withResolvedReferences: jest.fn(), resolve: jest.fn().mockResolvedValue([]) } },
    ],
  }).compile();

  return { service: moduleRef.get(ChatChannelsService), select };
}

const capabilityActor: EntityActor = {
  orgId: ORG_A,
  userId: USER_A,
  membershipId: MEMBERSHIP_A,
  isOrgOwner: false,
};

function activeMembership(): MembershipRow {
  return { id: MEMBERSHIP_A, orgId: ORG_A, userId: USER_A, status: "ACTIVE" };
}

describe("chat realtime capability — the token's channels follow from the membership rows", () => {
  it("grants only the channels the caller's own membership row sits on", async () => {
    const { service } = await buildCapabilityHarness({
      memberships: [activeMembership()],
      channelMembers: [
        { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_A, isArchived: false },
        { orgId: ORG_A, channelId: OTHER_CHANNEL_ID, membershipId: MEMBERSHIP_OTHER, isArchived: false },
        { orgId: ORG_B, channelId: 88, membershipId: MEMBERSHIP_A, isArchived: false },
      ],
    });

    expect(await service.listMemberChannelIds(capabilityActor)).toEqual([CHANNEL_ID]);
  });

  it("drops the channel from the next mint once the caller's own channel row is deleted", async () => {
    const world: CapabilityWorld = {
      memberships: [activeMembership()],
      channelMembers: [
        { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_A, isArchived: false },
        { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_OTHER, isArchived: false },
      ],
    };
    const { service } = await buildCapabilityHarness(world);
    expect(await service.listMemberChannelIds(capabilityActor)).toEqual([CHANNEL_ID]);

    world.channelMembers = world.channelMembers.filter((row) => row.membershipId !== MEMBERSHIP_A);

    expect(await service.listMemberChannelIds(capabilityActor)).toEqual([]);
  });

  it("grants nothing to a membership that is no longer ACTIVE, and never reads a channel row", async () => {
    const { service, select } = await buildCapabilityHarness({
      memberships: [{ ...activeMembership(), status: "SUSPENDED" }],
      channelMembers: [
        { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_A, isArchived: false },
      ],
    });

    expect(await service.listMemberChannelIds(capabilityActor)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("leaves an archived channel out of the grant", async () => {
    const { service } = await buildCapabilityHarness({
      memberships: [activeMembership()],
      channelMembers: [
        { orgId: ORG_A, channelId: CHANNEL_ID, membershipId: MEMBERSHIP_A, isArchived: true },
        { orgId: ORG_A, channelId: OTHER_CHANNEL_ID, membershipId: MEMBERSHIP_A, isArchived: false },
      ],
    });

    expect(await service.listMemberChannelIds(capabilityActor)).toEqual([OTHER_CHANNEL_ID]);
  });
});
