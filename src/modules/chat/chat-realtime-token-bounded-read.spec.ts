/**
 * PRD-C145 — the realtime-token path must meet its budget "without table scans,
 * N+1 or per-item cache/database calls".
 *
 * `GET /chat/ably-token` resolves the caller's channel capability list through
 * `ChatChannelListService.listMemberChannelIds`, which read EVERY non-archived
 * channel membership row for the member with no `LIMIT`, and only then handed
 * the array to `AblyService.createChatTokenRequest`, which grants at most
 * `MAX_CAPABILITY_CHANNELS` of them and discards the rest in memory. A member of
 * an organisation with 50,000 channels therefore paid for 50,000 rows on every
 * token mint — a read whose cost grows with the tenant, not with the grant.
 *
 * The bound belongs at the database. One row beyond the grant is still read so
 * the truncation the consumer performs stays observable here.
 */
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ChatChannelListService } from "./chat-channel-list.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { MAX_CAPABILITY_CHANNELS } from "../realtime/ably.service";

const ORG = "org-token";
const USER = "user-token";
const MEMBERSHIP = 4242;

function makeDb(channelRows: Array<{ channelId: number }>) {
  const limits: unknown[] = [];
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP }),
      },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn((n: unknown) => {
      limits.push(n);
      return Promise.resolve(channelRows);
    }),
  };
  return { db, limits };
}

async function buildService(db: unknown): Promise<ChatChannelListService> {
  const mod = await Test.createTestingModule({
    providers: [
      ChatChannelListService,
      { provide: DRIZZLE, useValue: db },
      { provide: EntityReferenceService, useValue: {} },
    ],
  }).compile();
  return mod.get(ChatChannelListService);
}

function rows(count: number): Array<{ channelId: number }> {
  return Array.from({ length: count }, (_, i) => ({ channelId: i + 1 }));
}

describe("PRD-C145 — the Ably token channel lookup is bounded at the database", () => {
  it("asks the database for at most one row beyond the capability grant", async () => {
    const { db, limits } = makeDb(rows(3));
    const service = await buildService(db);

    await service.listMemberChannelIds(ORG, USER);

    expect(limits).toEqual([MAX_CAPABILITY_CHANNELS + 1]);
  });

  it("never returns more rows than the grant plus its truncation probe", async () => {
    const { db } = makeDb(rows(MAX_CAPABILITY_CHANNELS + 1));
    const service = await buildService(db);

    const result = await service.listMemberChannelIds(ORG, USER);

    expect(result).toHaveLength(MAX_CAPABILITY_CHANNELS + 1);
  });

  it("still returns every channel for a member below the grant", async () => {
    const { db } = makeDb(rows(7));
    const service = await buildService(db);

    const result = await service.listMemberChannelIds(ORG, USER);

    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("reads nothing when the caller has no membership in the organization", async () => {
    const { db, limits } = makeDb(rows(3));
    db.query.organizationMembers.findFirst.mockResolvedValue(null);
    const service = await buildService(db);

    const result = await service.listMemberChannelIds(ORG, USER);

    expect(result).toEqual([]);
    expect(limits).toEqual([]);
  });
});
