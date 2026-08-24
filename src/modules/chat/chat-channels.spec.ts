import { Test, type TestingModule } from "@nestjs/testing";
import { ChatChannelsService, entityChannelFallbackName } from "./chat-channels.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const actor: EntityActor = { orgId: "org1", userId: "user1", isOrgOwner: false };

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

  const mockDb = {
    query: {
      chatChannels: { findMany: findManyMock, findFirst: jest.fn() },
    },
    update: updateSpy,
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: membershipWhere }),
    }),
    selectDistinctOn: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  };

  const mockCache = {
    cachedVersioned: jest.fn().mockResolvedValue([]),
    cached: jest.fn(),
    invalidate: jest.fn(),
    invalidateNamespace: jest.fn(),
    invalidatePattern: jest.fn(),
  };

  return { mockDb, mockCache, updateSpy, resolveSpy, findManyMock };
}

describe("ChatChannelsService — read path", () => {
  let service: ChatChannelsService;
  let updateSpy: jest.Mock;
  let resolveSpy: jest.Mock;
  let findManyMock: jest.Mock;

  beforeEach(async () => {
    const mocks = buildMocks();
    updateSpy = mocks.updateSpy;
    resolveSpy = mocks.resolveSpy;
    findManyMock = mocks.findManyMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
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
    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    expect(result[0]!.name).toBe("TICKET-1: Fix the bug");
  });

  it("falls back to the stored name when the adapter fails without aborting the list", async () => {
    resolveSpy.mockRejectedValue(new Error("adapter offline"));
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
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe(FALLBACK);
    expect(result[1]!.name).toBe("General");
  });
});
