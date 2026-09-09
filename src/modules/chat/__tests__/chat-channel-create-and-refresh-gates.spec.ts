import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
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
const CHANNEL_ID = 77;
const ACTOR: EntityActor = { orgId: ORG, userId: ACTOR_USER, membershipId: 3, isOrgOwner: false };

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

  const transaction = jest.fn(
    (run: (tx: { insert: typeof insert; query: typeof query }) => Promise<unknown>) =>
      run({ insert, query }),
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

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "chatChannels");
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
    expect(harness.transaction).not.toHaveBeenCalled();
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
