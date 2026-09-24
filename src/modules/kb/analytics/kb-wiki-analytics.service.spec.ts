import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbWikiAnalyticsService } from "./kb-wiki-analytics.service";
import type { WikiAnalyticsQuery } from "./dto/kb-wiki-analytics.schemas";

function makeChain(rows: unknown[] = []): object {
  const limit = jest.fn().mockImplementation(() => Promise.resolve(rows));
  const from = jest.fn();
  const leftJoin = jest.fn();
  const innerJoin = jest.fn();
  const where = jest.fn();
  const groupBy = jest.fn();
  const orderBy = jest.fn();
  const chain = Object.assign(Promise.resolve(rows), { from, leftJoin, innerJoin, where, groupBy, orderBy, limit });
  from.mockReturnValue(chain);
  leftJoin.mockReturnValue(chain);
  innerJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  groupBy.mockReturnValue(chain);
  orderBy.mockReturnValue(chain);
  return chain;
}

function makeDb(rows: unknown[] = []): Db {
  const chain = makeChain(rows);
  return {
    select: jest.fn().mockReturnValue(chain),
  } as unknown as Db;
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", principal: { kind: "human-session", membershipId: 1 } } as never;
}

const BASE_QUERY: WikiAnalyticsQuery = { limit: 10, cursor: undefined, from: undefined, to: undefined, spaceId: undefined };

const PAGE_ROW = {
  id: 1,
  title: "Page One",
  spaceId: null,
  status: "published" as const,
  trustState: "verified" as const,
  updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAtMicros: "2025-01-01T00:00:00.000000",
  uniqueViewers: 5,
};

const STALE_ROW = {
  id: 2,
  title: "Stale Page",
  spaceId: null,
  status: "draft" as const,
  ownerMembershipId: null,
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAtMicros: "2024-01-01T00:00:00.000000",
  uniqueViewers: 0,
};

const CONTRIBUTOR_ROW = {
  membershipId: 10,
  editCount: 42,
};

describe("KbWikiAnalyticsService — pageStats", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns an empty page when no rows match", async () => {
    const db = makeDb([]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.pageStats(makeUser(), BASE_QUERY);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("strips the updatedAtMicros cursor field from returned items", async () => {
    const db = makeDb([PAGE_ROW]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.pageStats(makeUser(), BASE_QUERY);
    expect(result.data).toHaveLength(1);
    expect("updatedAtMicros" in result.data[0]).toBe(false);
    expect(result.data[0].id).toBe(PAGE_ROW.id);
    expect(result.data[0].uniqueViewers).toBe(PAGE_ROW.uniqueViewers);
  });

  it("emits a nextCursor when the sentinel row is present", async () => {
    const sentinel = { ...PAGE_ROW, id: 2 };
    const db = makeDb([PAGE_ROW, sentinel]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.pageStats(makeUser(), { ...BASE_QUERY, limit: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
  });
});

describe("KbWikiAnalyticsService — stalePages", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns empty page when no stale pages exist", async () => {
    const db = makeDb([]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.stalePages(makeUser(), BASE_QUERY);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("strips the updatedAtMicros cursor field from stale page items", async () => {
    const db = makeDb([STALE_ROW]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.stalePages(makeUser(), BASE_QUERY);
    expect(result.data).toHaveLength(1);
    expect("updatedAtMicros" in result.data[0]).toBe(false);
    expect(result.data[0].ownerMembershipId).toBeNull();
  });
});

describe("KbWikiAnalyticsService — contributorActivity", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns contributor list bounded at service constant", async () => {
    const db = makeDb([CONTRIBUTOR_ROW]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.contributorActivity(makeUser(), BASE_QUERY);
    expect(result).toHaveLength(1);
    expect(result[0].editCount).toBe(42);
    expect(result[0].membershipId).toBe(10);
  });

  it("returns empty array when no versions exist", async () => {
    const db = makeDb([]);
    const svc = new KbWikiAnalyticsService(db, auth as never);
    const result = await svc.contributorActivity(makeUser(), BASE_QUERY);
    expect(result).toHaveLength(0);
  });
});
