import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { chatMessageContentMatch, escapeLike } from "./chat-message-content-match";
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

describe("ChatSearchService — search terms and failures", () => {
  const dialect = new PgDialect();

  it("escapes LIKE wildcards so `%` and `_` match themselves", () => {
    expect(escapeLike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
  });

  it("hands the escaped term to the trigram helper", async () => {
    const execute = jest.fn().mockResolvedValue([]);
    await chatMessageContentMatch({ execute } as never, "100%");
    expect(dialect.sqlToQuery(execute.mock.calls[0][0]).params).toContain("100\\%");
  });

  it("surfaces a failed message search instead of answering no matches", async () => {
    const db = { execute: jest.fn().mockRejectedValue(new Error("db down")) };
    const { service } = await buildService(db);
    await expect(service.searchMessages(actor, "hello")).rejects.toThrow("db down");
  });

  it("loads the attachments and folded reactions its response schema declares", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 1,
        content: "hi",
        senderMembership: { userId: "u1", user: { id: "u1", name: "Ann", image: null } },
        channel: { id: 5, name: "general", type: "PUBLIC", entityType: null, entityId: null },
        attachments: [],
        reactions: [{ emoji: "👍", membership: { userId: "u2" } }],
      },
    ]);
    const { service } = await buildService({ query: { chatMessages: { findMany } } });
    const { results } = await service.searchMessages(actor, "hi");
    expect(findMany.mock.calls[0][0].with).toMatchObject({ attachments: true, reactions: expect.any(Object) });
    expect(results[0]).toMatchObject({ attachments: [], reactions: { "👍": ["u2"] } });
  });

  it("offers only ACTIVE organization members as users", async () => {
    let where: SQL | undefined;
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (w: SQL) => ((where = w), chain),
      limit: jest.fn().mockResolvedValue([]),
    };
    const { service } = await buildService({ select: () => chain });
    await service.searchUsers(ORG, "ann");
    const compiled = dialect.sqlToQuery(where as SQL);
    expect(compiled.sql).toContain('"organization_members"."status" = ');
    expect(compiled.params).toContain("ACTIVE");
  });
});
