import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ChatChannelsService } from "../chat-channels.service";
import { ChatChannelListService } from "../chat-channel-list.service";
import { createChannelSchema, type CreateChannelInput } from "../dto/chat.schemas";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { chatChannels } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

const ORG = "org-1";
const ACTOR_USER = "user-1";
const OTHER_USER = "user-2";
const THIRD_USER = "user-3";
const CHANNEL_ID = 77;
const ACTOR_MEMBERSHIP = 3;
const OTHER_MEMBERSHIP = 4;
const THIRD_MEMBERSHIP = 9;
const NEW_DM_ID = 501;
const ACTOR: EntityActor = { orgId: ORG, userId: ACTOR_USER, membershipId: 3, isOrgOwner: false };

const dialect = new PgDialect();

const CLEAN_GROUP_BODY = {
  type: "GROUP",
  name: "Project 42",
  memberIds: [OTHER_USER],
} satisfies CreateChannelInput;

interface InsertCall {
  table: unknown;
  values: unknown;
}

interface CreateHarness {
  service: ChatChannelsService;
  inserts: InsertCall[];
  transaction: jest.Mock;
}

function insertedChannelRow(inserts: readonly InsertCall[]): unknown {
  const call = inserts.find((entry) => entry.table === chatChannels);
  if (!call) throw new Error("no chat_channels insert was issued");
  return call.values;
}

async function buildCreateHarness(assertWithinLimit: jest.Mock): Promise<CreateHarness> {
  const inserts: InsertCall[] = [];

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });
      return {
        returning: () => Promise.resolve([{ id: CHANNEL_ID, orgId: ORG }]),
        then: (resolve: (value: undefined) => unknown) => resolve(undefined),
      };
    },
  });

  const query = {
    chatChannels: {
      findFirst: () =>
        Promise.resolve({ id: CHANNEL_ID, orgId: ORG, name: "Project 42", members: [] }),
    },
  };

  const execute = jest.fn(() => Promise.resolve([]));

  const transaction = jest.fn(
    (
      run: (tx: {
        insert: typeof insert;
        query: typeof query;
        execute: typeof execute;
      }) => Promise<unknown>,
    ) => run({ insert, query, execute }),
  );

  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { userId: ACTOR_USER, membershipId: 3 },
            { userId: OTHER_USER, membershipId: 4 },
          ]),
      }),
    }),
    transaction,
  } as unknown as Db;

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChatChannelsService,
      { provide: DRIZZLE, useValue: db },
      { provide: PlanLimitsService, useValue: { assertWithinLimit } },
      { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
      { provide: EntityReferenceService, useValue: { resolve: jest.fn() } },
      {
        provide: ChatChannelListService,
        useValue: { getMembershipId: jest.fn().mockResolvedValue(3) },
      },
    ],
  }).compile();

  return { service: module.get(ChatChannelsService), inserts, transaction };
}

describe("POST /chat/channels — a client-supplied record binding cannot reach the table", () => {
  it("refuses a create body that names a record", () => {
    const parsed = createChannelSchema.safeParse({
      ...CLEAN_GROUP_BODY,
      entityType: "project",
      entityId: "42",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts the same body without the record binding (control)", () => {
    const parsed = createChannelSchema.parse(CLEAN_GROUP_BODY);

    expect(Object.keys(parsed)).not.toContain("entityType");
    expect(Object.keys(parsed)).not.toContain("entityId");
  });

  it("writes no entity columns even when the caller hands the service a record binding", async () => {
    const harness = await buildCreateHarness(jest.fn().mockResolvedValue(undefined));
    const bodyNamingARecord = { ...CLEAN_GROUP_BODY, entityType: "project", entityId: "42" };

    await harness.service.createChannel(ORG, ACTOR_USER, bodyNamingARecord);

    const row = insertedChannelRow(harness.inserts);
    expect(row).toHaveProperty("name", "Project 42");
    expect(row).not.toHaveProperty("entityType");
    expect(row).not.toHaveProperty("entityId");
  });

  it("meters the channel quota on the create, whatever the body says", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const harness = await buildCreateHarness(assertWithinLimit);
    const bodyNamingARecord = { ...CLEAN_GROUP_BODY, entityType: "project", entityId: "42" };

    await harness.service.createChannel(ORG, ACTOR_USER, bodyNamingARecord);

    expect(assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(assertWithinLimit.mock.calls[0]?.[0]).toBe(ORG);
    expect(assertWithinLimit.mock.calls[0]?.[1]).toBe("chatChannels");
    expect(assertWithinLimit.mock.calls[0]?.[2]).toBe(1);
    expect(assertWithinLimit.mock.calls[0]?.[3]).toBeDefined();
  });

  it("does not insert when the quota is exhausted", async () => {
    const assertWithinLimit = jest.fn().mockRejectedValue(
      new PaymentRequiredException({
        code: "QUOTA_EXCEEDED",
        message: "Your Free plan allows 5 chat channels and 5 are already in use.",
        details: {},
      }),
    );
    const harness = await buildCreateHarness(assertWithinLimit);

    await expect(harness.service.createChannel(ORG, ACTOR_USER, CLEAN_GROUP_BODY)).rejects.toThrow(
      PaymentRequiredException,
    );
    expect(harness.inserts).toHaveLength(0);
  });
});

interface RefreshHarness {
  service: ChatChannelsService;
  update: jest.Mock;
  resolveDisplayName: jest.Mock;
}

async function buildRefreshHarness(
  channel: Record<string, unknown> | undefined,
  member: { role: string } | undefined,
): Promise<RefreshHarness> {
  const update = jest.fn(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }));

  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(member) },
    },
    update,
  } as unknown as Db;

  const resolveDisplayName = jest
    .fn()
    .mockImplementation((row: { name: string }) => Promise.resolve({ ...row, name: "TICKET-42: Fix it" }));

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChatChannelsService,
      { provide: DRIZZLE, useValue: db },
      { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
      { provide: EntityReferenceService, useValue: { resolve: jest.fn() } },
      {
        provide: ChatChannelListService,
        useValue: {
          getMembershipId: jest.fn().mockResolvedValue(3),
          resolveEntityChannelDisplayName: resolveDisplayName,
        },
      },
    ],
  }).compile();

  return { service: module.get(ChatChannelsService), update, resolveDisplayName };
}

const PRIVATE_ENTITY_CHANNEL = {
  id: CHANNEL_ID,
  name: "Project: 42",
  isPrivate: true,
  entityType: "ticket",
  entityId: "42",
};

async function refusalOf(service: ChatChannelsService): Promise<unknown> {
  return service.reconcileEntityChannelDisplayName(CHANNEL_ID, ACTOR).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("POST /chat/channels/:channelId/refresh-name — a non-member is told nothing", () => {
  it("refuses a private channel in the caller's own org that the caller has not joined", async () => {
    const harness = await buildRefreshHarness(PRIVATE_ENTITY_CHANNEL, undefined);

    await expect(
      harness.service.reconcileEntityChannelDisplayName(CHANNEL_ID, ACTOR),
    ).rejects.toThrow(NotFoundException);
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.resolveDisplayName).not.toHaveBeenCalled();
  });

  it("answers a non-member and a non-existent channel identically, so ids cannot be enumerated", async () => {
    const nonMember = await buildRefreshHarness(PRIVATE_ENTITY_CHANNEL, undefined);
    const absent = await buildRefreshHarness(undefined, undefined);

    const [denied, missing] = await Promise.all([refusalOf(nonMember.service), refusalOf(absent.service)]);

    expect(denied).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    if (!(denied instanceof NotFoundException) || !(missing instanceof NotFoundException))
      throw new Error("both outcomes must be NotFoundException to be compared");
    expect(denied.message).toBe(missing.message);
    expect(denied.getStatus()).toBe(missing.getStatus());
  });

  it("still recomputes the name for a member of the channel (control)", async () => {
    const harness = await buildRefreshHarness(PRIVATE_ENTITY_CHANNEL, { role: "MEMBER" });

    await expect(
      harness.service.reconcileEntityChannelDisplayName(CHANNEL_ID, ACTOR),
    ).resolves.toBeUndefined();
    expect(harness.resolveDisplayName).toHaveBeenCalled();
    expect(harness.update).toHaveBeenCalled();
  });
});

interface ExistingDm {
  id: number;
  members: { membershipId: number }[];
}

interface DmHarness {
  service: ChatChannelsService;
  inserts: InsertCall[];
  existingDmLookup: () => SQL;
  events: string[];
}

const MEMBERSHIP_BY_USER = new Map<string, number>([
  [ACTOR_USER, ACTOR_MEMBERSHIP],
  [OTHER_USER, OTHER_MEMBERSHIP],
  [THIRD_USER, THIRD_MEMBERSHIP],
]);

const USER_NAMES = new Map<string, string>([
  [ACTOR_USER, "Alice"],
  [OTHER_USER, "Bob"],
]);

function boundChannelId(where: SQL): number {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const match = /"chat_channels"\."id"\s*=\s*\$(\d+)/i.exec(text);
  if (!match?.[1]) throw new Error(`the channel detail read does not bind chat_channels.id: ${text}`);
  const value = params[Number(match[1]) - 1];
  if (typeof value !== "number") throw new Error("chat_channels.id is not bound to a number");
  return value;
}

function membersOf(existingDMs: readonly ExistingDm[], channelId: number): { membershipId: number }[] {
  return existingDMs.find((dm) => dm.id === channelId)?.members ?? [{ membershipId: ACTOR_MEMBERSHIP }];
}

async function buildDmHarness(existingDMs: readonly ExistingDm[], dmLookupResult?: ExistingDm): Promise<DmHarness> {
  const inserts: InsertCall[] = [];
  const events: string[] = [];
  let dmLookupWhere: SQL | undefined;

  const detailFindFirst = (config: { where?: SQL }) => {
    if (!config.where) throw new Error("the channel detail read ran with no predicate");
    const id = boundChannelId(config.where);
    return Promise.resolve({
      id,
      orgId: ORG,
      name: "detail",
      type: "DIRECT",
      isPrivate: true,
      entityType: null,
      entityId: null,
      members: membersOf(existingDMs, id).map((member) => ({
        id: member.membershipId,
        channelId: id,
        role: "MEMBER",
        membership: { userId: ACTOR_USER, user: { id: ACTOR_USER, name: "Alice", image: null, email: null } },
      })),
    });
  };

  const query = {
    chatChannels: {
      findFirst: jest.fn(detailFindFirst),
    },
    users: {
      findFirst: jest.fn(({ where }: { where?: SQL }) => {
        const params = where ? dialect.sqlToQuery(where).params : [];
        const id = params.find((param): param is string => typeof param === "string");
        return Promise.resolve({ name: id ? USER_NAMES.get(id) ?? null : null });
      }),
    },
  };

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });
      return {
        returning: () => Promise.resolve([{ id: NEW_DM_ID, orgId: ORG }]),
        then: (resolve: (value: undefined) => unknown) => resolve(undefined),
      };
    },
  });

  let selectCall = 0;
  const select = () => {
    const index = selectCall++;

    if (index === 0) {
      return {
        from: () => ({
          where: () =>
            Promise.resolve([
              { userId: ACTOR_USER },
              { userId: OTHER_USER },
              { userId: THIRD_USER },
            ]),
        }),
      };
    }

    const lookupChain: Record<string, unknown> = {};
    lookupChain.innerJoin = jest.fn(() => lookupChain);
    lookupChain.where = jest.fn((w: SQL) => {
      events.push("lookup");
      dmLookupWhere = w;
      return {
        limit: jest.fn(() =>
          Promise.resolve(dmLookupResult ? [{ id: dmLookupResult.id }] : []),
        ),
      };
    });
    return { from: jest.fn(() => lookupChain) };
  };

  const db = {
    query,
    select,
    insert,
    transaction: jest.fn(
      (
        run: (tx: {
          insert: typeof insert;
          query: typeof query;
          select: typeof select;
          execute: jest.Mock;
        }) => Promise<unknown>,
      ) =>
        run({
          insert,
          query,
          select,
          execute: jest.fn((statement: SQL) => {
            events.push(`lock:${String(dialect.sqlToQuery(statement).params[0])}`);
            return Promise.resolve([]);
          }),
        }),
    ),
  } as unknown as Db;

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ChatChannelsService,
      { provide: DRIZZLE, useValue: db },
      { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
      { provide: EntityReferenceService, useValue: { resolve: jest.fn() } },
      {
        provide: ChatChannelListService,
        useValue: {
          getMembershipId: jest.fn((_orgId: string, userId: string) =>
            Promise.resolve(MEMBERSHIP_BY_USER.get(userId) ?? null),
          ),
        },
      },
    ],
  }).compile();

  return {
    service: module.get(ChatChannelsService),
    inserts,
    existingDmLookup: () => {
      if (!dmLookupWhere) throw new Error("the existing-DM lookup never ran");
      return dmLookupWhere;
    },
    events,
  };
}

const PAIR_DM: ExistingDm = {
  id: 91,
  members: [{ membershipId: ACTOR_MEMBERSHIP }, { membershipId: OTHER_MEMBERSHIP }],
};
const SELF_DM: ExistingDm = { id: 92, members: [{ membershipId: ACTOR_MEMBERSHIP }] };
const THIRD_PARTY_DM: ExistingDm = {
  id: 93,
  members: [{ membershipId: ACTOR_MEMBERSHIP }, { membershipId: THIRD_MEMBERSHIP }],
};

function directBody(targetUserId: string) {
  return { type: "DIRECT" as const, targetUserId };
}

describe("POST /chat/channels type=DIRECT — a second conversation with the same person is never created", () => {
  it("returns the DM that already exists with that person and writes nothing", async () => {
    const harness = await buildDmHarness([PAIR_DM], PAIR_DM);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    expect(result.created).toBe(false);
    expect(result.channel.id).toBe(PAIR_DM.id);
    expect(harness.inserts).toHaveLength(0);
  });

  it("takes one pair-keyed advisory lock before the lookup, whichever side opens the DM", async () => {
    const forward = await buildDmHarness([]);
    const reverse = await buildDmHarness([]);

    await forward.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));
    await reverse.service.createChannel(ORG, OTHER_USER, directBody(ACTOR_USER));

    expect(forward.events).toEqual([`lock:chat-dm:${ORG}:${ACTOR_MEMBERSHIP}:${OTHER_MEMBERSHIP}`, "lookup"]);
    expect(reverse.events).toEqual(forward.events);
  });

  it("CONTROL: with no DM on record it creates one channel and two membership rows", async () => {
    const harness = await buildDmHarness([]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    expect(result.created).toBe(true);
    expect(result.channel.id).toBe(NEW_DM_ID);
    expect(insertedChannelRow(harness.inserts)).toMatchObject({ type: "DIRECT", isPrivate: true });
    const memberRows = harness.inserts.find((entry) => entry.table !== chatChannels)?.values;
    expect(memberRows).toEqual([
      { orgId: ORG, channelId: NEW_DM_ID, membershipId: ACTOR_MEMBERSHIP, role: "MEMBER" },
      { orgId: ORG, channelId: NEW_DM_ID, membershipId: OTHER_MEMBERSHIP, role: "MEMBER" },
    ]);
  });

  it("does not hand back the DM the caller has with a DIFFERENT person", async () => {
    const harness = await buildDmHarness([THIRD_PARTY_DM]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    expect(result.created).toBe(true);
    expect(result.channel.id).toBe(NEW_DM_ID);
  });

  it("does not hand back the caller's own self-DM when they ask for a DM with someone else", async () => {
    const harness = await buildDmHarness([SELF_DM]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    expect(result.created).toBe(true);
    expect(result.channel.id).toBe(NEW_DM_ID);
  });

  it("the existing-DM lookup binds type = DIRECT and the caller's org, so a GROUP is never reused", async () => {
    const harness = await buildDmHarness([PAIR_DM], PAIR_DM);

    await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    const { sql: text, params } = dialect.sqlToQuery(harness.existingDmLookup());
    expect(text).toMatch(/"chat_channels"\."type"\s*=\s*\$\d+/i);
    expect(text).toMatch(/"chat_channels"\."org_id"\s*=\s*\$\d+/i);
    expect(params).toContain("DIRECT");
    expect(params).toContain(ORG);
  });

  it("bounded self-join on membership tables replaces loading all creator channel-memberships then all their DIRECT channels", async () => {
    const harness = await buildDmHarness([PAIR_DM], PAIR_DM);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(OTHER_USER));

    expect(result.created).toBe(false);
    expect(result.channel.id).toBe(PAIR_DM.id);
  });
});

describe("POST /chat/channels type=DIRECT — a self-DM dedupes on the single-member shape", () => {
  it("returns the existing one-member channel instead of a second note to self", async () => {
    const harness = await buildDmHarness([SELF_DM], SELF_DM);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(ACTOR_USER));

    expect(result.created).toBe(false);
    expect(result.channel.id).toBe(SELF_DM.id);
    expect(harness.inserts).toHaveLength(0);
  });

  it("does not mistake the two-member DM the caller is already in for their self-DM", async () => {
    const harness = await buildDmHarness([PAIR_DM]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(ACTOR_USER));

    expect(result.created).toBe(true);
    expect(result.channel.id).toBe(NEW_DM_ID);
  });

  it("CONTROL: the created self-DM carries exactly one membership row, named for the caller alone", async () => {
    const harness = await buildDmHarness([]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(ACTOR_USER));

    expect(result.created).toBe(true);
    expect(insertedChannelRow(harness.inserts)).toMatchObject({ type: "DIRECT", name: "Alice" });
    expect(harness.inserts.find((entry) => entry.table !== chatChannels)?.values).toEqual([
      { orgId: ORG, channelId: NEW_DM_ID, membershipId: ACTOR_MEMBERSHIP, role: "MEMBER" },
    ]);
  });

  it("NOT EXISTS guard on the member table prevents mistaking a two-member DM for the self-DM, replacing a JS member-count check", async () => {
    const harness = await buildDmHarness([PAIR_DM]);

    const result = await harness.service.createChannel(ORG, ACTOR_USER, directBody(ACTOR_USER));

    expect(result.created).toBe(true);
    expect(result.channel.id).toBe(NEW_DM_ID);
  });
});
