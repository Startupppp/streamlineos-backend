import { ChatChannelsService } from "../chat-channels.service";
import { logger } from "../../../common/logger/logger.service";
import { entityChannelFallbackName } from "../chat-channels.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

const actor: EntityActor = {
  userId: "user-1",
  orgId: "org-1",
  isOrgOwner: false,
  membershipId: 10,
  permissions: [],
} as unknown as EntityActor;

function makeDb(channels: unknown[]) {
  const update = jest.fn(() => ({
    set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  }));

  const results: unknown[][] = [[{ channelId: 1 }]];
  const nextResult = (): unknown[] => results.shift() ?? [];

  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "groupBy", "orderBy", "limit"])
      chain[method] = jest.fn(() => chain);
    chain.then = (resolve: (v: unknown[]) => unknown) => resolve(nextResult());
    return chain;
  };

  const db = {
    update,
    select: jest.fn(() => makeChain()),
    selectDistinctOn: jest.fn(() => makeChain()),
    query: {
      chatChannels: {
        findMany: jest.fn().mockResolvedValue(channels),
        findFirst: jest.fn().mockResolvedValue(channels[0] ?? null),
      },
      chatChannelMembers: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
  return { db, update };
}

const entityChannel = {
  id: 1,
  orgId: "org-1",
  name: entityChannelFallbackName("build.ticket", "7"),
  entityType: "build.ticket",
  entityId: "7",
  type: "ENTITY",
  members: [],
};

function makeEntities(title: string) {
  return {
    resolve: jest.fn().mockResolvedValue([
      { status: "resolved", card: { title } },
    ]),
  };
}

function makeFailingDb(error: Error) {
  return {
    update: jest.fn(),
    select: jest.fn(() => {
      throw error;
    }),
    selectDistinctOn: jest.fn(),
    query: {
      chatChannels: { findMany: jest.fn(), findFirst: jest.fn() },
      chatChannelMembers: { findMany: jest.fn() },
    },
  };
}

describe("ChatChannelsService — the channel list is a read", () => {
  beforeEach(() => {
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  it("surfaces a db failure as an exception, not an empty channel list", async () => {
    const db = makeFailingDb(new Error("DB connection lost"));
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn() } as never,
      makeEntities("title") as never,
    );

    await expect(service.getMyChannels(actor)).rejects.toThrow();
  });

  it("issues no write while listing channels whose entity has been renamed", async () => {
    const { db, update } = makeDb([entityChannel]);
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn(async (_n: string, _k: string, fn: () => unknown) => fn()) } as never,
      makeEntities("Renamed ticket") as never,
    );

    await service.getMyChannels(actor);

    expect(update).not.toHaveBeenCalled();
  });

  it("still shows the entity's current name to the reader", async () => {
    const { db } = makeDb([entityChannel]);
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn(async (_n: string, _k: string, fn: () => unknown) => fn()) } as never,
      makeEntities("Renamed ticket") as never,
    );

    const channels = await service.getMyChannels(actor);

    expect(channels[0]?.name).toBe("Renamed ticket");
  });
});
