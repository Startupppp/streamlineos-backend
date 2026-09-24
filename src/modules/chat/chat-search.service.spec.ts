import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ChatSearchService } from "./chat-search.service";
import { ChatChannelListService } from "./chat-channel-list.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const ORG = "org-search-spec";
const USER = "user-search-spec";
const actor: EntityActor = { orgId: ORG, userId: USER, membershipId: 7, isOrgOwner: false };

const passThroughEntities = {
  withResolvedReferences: jest
    .fn()
    .mockImplementation(<T>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
  resolve: jest.fn().mockResolvedValue([]),
} as unknown as EntityReferenceService;

function makeDb(channelRows: unknown[] = []) {
  return {
    query: {
      chatChannels: {
        findMany: jest.fn().mockResolvedValue(channelRows),
      },
    },
  };
}

async function buildService(
  db: unknown,
  memberChannelIds: number[] = [],
): Promise<{ service: ChatSearchService; listMemberChannelIdsMock: jest.Mock }> {
  const listMemberChannelIdsMock = jest.fn().mockResolvedValue(memberChannelIds);
  const mod = await Test.createTestingModule({
    providers: [
      ChatSearchService,
      { provide: DRIZZLE, useValue: db },
      { provide: EntityReferenceService, useValue: passThroughEntities },
      {
        provide: ChatChannelListService,
        useValue: { listMemberChannelIds: listMemberChannelIdsMock },
      },
    ],
  }).compile();
  return { service: mod.get(ChatSearchService), listMemberChannelIdsMock };
}

describe("ChatSearchService.searchChannels — membership read is bounded", () => {
  it("delegates to listMemberChannelIds so the database never reads every membership row for the caller", async () => {
    const db = makeDb();
    const { service, listMemberChannelIdsMock } = await buildService(db);

    await service.searchChannels(actor, "general");

    expect(listMemberChannelIdsMock).toHaveBeenCalledTimes(1);
  });

  it("still reaches an archived channel the caller belongs to, because search is how a person finds one", async () => {
    const db = makeDb([]);
    const { service, listMemberChannelIdsMock } = await buildService(db);

    await service.searchChannels(actor, "quarterly");

    expect(listMemberChannelIdsMock).toHaveBeenCalledWith(actor, { includeArchived: true });
  });

  it("returns an empty result without calling listMemberChannelIds when the search term is blank", async () => {
    const db = makeDb();
    const { service, listMemberChannelIdsMock } = await buildService(db);

    const result = await service.searchChannels(actor, "   ");

    expect(result).toEqual([]);
    expect(listMemberChannelIdsMock).not.toHaveBeenCalled();
  });

  it("marks a channel isMember: true when its id is in the bounded member list", async () => {
    const channelId = 42;
    const db = makeDb([
      {
        id: channelId,
        name: "general",
        type: "PUBLIC",
        description: null,
        avatarUrl: null,
        entityType: null,
        entityId: null,
      },
    ]);
    const { service } = await buildService(db, [channelId]);

    const results = await service.searchChannels(actor, "general");

    expect(results.find((r) => r.id === channelId)?.isMember).toBe(true);
  });

  it("marks a channel isMember: false when its id is absent from the bounded member list", async () => {
    const channelId = 43;
    const db = makeDb([
      {
        id: channelId,
        name: "announcements",
        type: "PUBLIC",
        description: null,
        avatarUrl: null,
        entityType: null,
        entityId: null,
      },
    ]);
    const { service } = await buildService(db, []);

    const results = await service.searchChannels(actor, "announcements");

    expect(results.find((r) => r.id === channelId)?.isMember).toBe(false);
  });
});
