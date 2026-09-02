import { Test, type TestingModule } from "@nestjs/testing";
import { ChatChannelsService, entityChannelFallbackName } from "./chat-channels.service";
import { ChatChannelListService } from "./chat-channel-list.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const actor: EntityActor = { orgId: "org1", userId: "user1", membershipId: 10, isOrgOwner: false };

const FALLBACK = entityChannelFallbackName("ticket", "1");

const resolvedCard = {
  status: "resolved" as const,
  card: {
    type: "ticket",
    id: "1",
    title: "TICKET-1: Fix the bug",
    subtitle: null,
    status: "OPEN",
    href: "/t/1",
  },
};

function buildMocks() {
  const updateSpy = jest.fn().mockReturnThis();
  const resolveSpy = jest.fn().mockResolvedValue([resolvedCard]);
  const findManyMock = jest.fn().mockResolvedValue([
    {
      id: 1,
      orgId: "org1",
      name: FALLBACK,
      type: "GROUP",
      entityType: "ticket",
      entityId: "1",
      isArchived: false,
      description: null,
      avatarUrl: null,
      isPrivate: false,
      createdBy: "user1",
      createdAt: new Date(),
      lastMessageAt: new Date(),
      members: [],
    },
  ]);

  const membershipWhere = jest.fn().mockResolvedValue([{ channelId: 1 }]);

  const distinctChain: { leftJoin: jest.Mock; where: jest.Mock; orderBy: jest.Mock } = {
    leftJoin: jest.fn(() => distinctChain),
    where: jest.fn(() => distinctChain),
    orderBy: jest.fn().mockResolvedValue([]),
  };

  let selectCallIdx = 0;
  const selectResults: unknown[][] = [
    [{ id: 1, lastMessageAt: null }],
    [],
  ];
  const makeSelectChain = () => {
    const resultIdx = selectCallIdx++;
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "groupBy", "having", "orderBy", "limit"])
      chain[method] = jest.fn(() => chain);
    chain.then = (resolve: (v: unknown[]) => unknown) => resolve(selectResults[resultIdx] ?? []);
    return chain;
  };

  const mockDb = {
    query: {
      chatChannels: { findMany: findManyMock, findFirst: jest.fn() },
    },
    update: updateSpy,
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    select: jest.fn(() => makeSelectChain()),
    selectDistinctOn: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(distinctChain),
    }),
  };

  const mockCache = {
    cachedVersioned: jest.fn().mockResolvedValue([]),
    cached: jest.fn(),
    invalidate: jest.fn(),
    invalidateNamespace: jest.fn(),
  };

  return { mockDb, mockCache, updateSpy, resolveSpy, findManyMock, selectResults };
}

describe("ChatChannelsService — read path", () => {
  let service: ChatChannelsService;
  let updateSpy: jest.Mock;
  let resolveSpy: jest.Mock;
  let findManyMock: jest.Mock;
  let selectResults: unknown[][];

  beforeEach(async () => {
    const mocks = buildMocks();
    updateSpy = mocks.updateSpy;
    resolveSpy = mocks.resolveSpy;
    selectResults = mocks.selectResults;
    findManyMock = mocks.findManyMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatChannelListService,
        ChatChannelsService,
        { provide: DRIZZLE, useValue: mocks.mockDb },
        { provide: CacheService, useValue: mocks.mockCache },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: EntityReferenceService, useValue: { resolve: resolveSpy } },
      ],
    }).compile();

    service = module.get(ChatChannelsService);
  });

  it("resolves the display name for an entity channel without writing to the database", async () => {
    const result = await service.getMyChannels(actor);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toBeDefined();
    expect(result.channels[0]!.name).toBe("TICKET-1: Fix the bug");
  });

  it("falls back to the stored name when the adapter fails without aborting the list", async () => {
    resolveSpy.mockRejectedValue(new Error("adapter offline"));
    selectResults[0] = [{ id: 1, lastMessageAt: null }, { id: 2, lastMessageAt: null }];
    findManyMock.mockResolvedValue([
      {
        id: 1,
        orgId: "org1",
        name: FALLBACK,
        type: "GROUP",
        entityType: "ticket",
        entityId: "1",
        isArchived: false,
        description: null,
        avatarUrl: null,
        isPrivate: false,
        createdBy: "user1",
        createdAt: new Date(),
        lastMessageAt: new Date(),
        members: [],
      },
      {
        id: 2,
        orgId: "org1",
        name: "General",
        type: "PUBLIC",
        entityType: null,
        entityId: null,
        isArchived: false,
        description: null,
        avatarUrl: null,
        isPrivate: false,
        createdBy: "user1",
        createdAt: new Date(),
        lastMessageAt: new Date(),
        members: [],
      },
    ]);

    const result = await service.getMyChannels(actor);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]!.name).toBe(FALLBACK);
    expect(result.channels[1]!.name).toBe("General");
  });
});
