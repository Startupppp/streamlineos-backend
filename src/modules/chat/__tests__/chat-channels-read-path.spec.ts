import { ChatChannelsService } from "../chat-channels.service";
import { ChatChannelListService } from "../chat-channel-list.service";
import { logger } from "../../../common/logger/logger.service";
import { entityChannelFallbackName } from "../chat-channels.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

const actor: EntityActor = {
  userId: "user-1",
  orgId: "org-1",
  membershipId: 10,
  isOrgOwner: false,
  permissions: [],
} as unknown as EntityActor;

function makeDb(channels: unknown[]) {
  const update = jest.fn(() => ({
    set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  }));

  const results: unknown[][] = [[{ id: 1, lastMessageAt: null }], []];
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
    const listService = new ChatChannelListService(db as never, makeEntities("title") as never);
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn() } as never,
      makeEntities("title") as never,
      listService,
    );

    await expect(service.getMyChannels(actor)).rejects.toThrow();
  });

  it("issues no write while listing channels whose entity has been renamed", async () => {
    const { db, update } = makeDb([entityChannel]);
    const listService = new ChatChannelListService(db as never, makeEntities("Renamed ticket") as never);
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn(async (_n: string, _k: string, fn: () => unknown) => fn()) } as never,
      makeEntities("Renamed ticket") as never,
      listService,
    );

    await service.getMyChannels(actor);

    expect(update).not.toHaveBeenCalled();
  });

  it("still shows the entity's current name to the reader", async () => {
    const { db } = makeDb([entityChannel]);
    const listService = new ChatChannelListService(db as never, makeEntities("Renamed ticket") as never);
    const service = new ChatChannelsService(
      db as never,
      { assertWithinLimit: jest.fn() } as never,
      { cachedVersioned: jest.fn(async (_n: string, _k: string, fn: () => unknown) => fn()) } as never,
      makeEntities("Renamed ticket") as never,
      listService,
    );

    const result = await service.getMyChannels(actor);

    expect(result.channels[0]?.name).toBe("Renamed ticket");
  });
});
