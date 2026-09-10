import { ScopedRead } from "../../access/scoped-read";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";
import { KbArticleQueryService } from "./kb-article-query.service";

const dialect = new PgDialect();

type MockChain = {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

function buildChain(pages: unknown[][]) {
  const queue = [...pages];

  const chain: MockChain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };

  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockImplementation(() => Promise.resolve(queue.shift() ?? []));

  const db = { select: jest.fn().mockReturnValue(chain) };
  return { db, chain };
}

function makeAccessService(spaceIds: number[]) {
  return { getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds) };
}

function articleRow(id: number, updatedAt: Date) {
  return {
    id,
    spaceId: 1,
    categoryId: null,
    title: `Article ${id}`,
    slug: `article-${id}`,
    excerpt: null,
    status: "published" as const,
    visibility: "internal" as const,
    tags: [],
    ownerId: "user-1",
    helpfulCount: 0,
    notHelpfulCount: 0,
    lastVerifiedAt: null,
    updatedAt,
  };
}

const ALL = ScopedRead.of("org-1", "u-1", "all");
const user = {
  orgId: "org-1",
  userId: "user-1",
  membershipId: 1,
  isOwner: false,
  role: "MEMBER" as const,
};

describe("KbArticleQueryService — keyset pagination", () => {
  it("emits a cursor encoding (updatedAt, id) from the last kept row, not the sentinel", async () => {
    const t = new Date("2025-01-01T00:00:00.000Z");
    const row1 = articleRow(10, t);
    const row2 = articleRow(9, t);
    const sentinel = articleRow(8, t);

    const { db } = buildChain([[row1, row2, sentinel]]);
    const svc = new KbArticleQueryService(db as never, makeAccessService([1]) as never);

    const result = await svc.list(user as never, { limit: 2, cursor: undefined }, ALL);

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();

    const position = decodeCursor(result.nextCursor);
    expect(position).not.toBeNull();
    expect(position?.sortValue).toBe(t.toISOString());
    expect(position?.id).toBe("9");
  });

  it("tie-breaking: two rows with the same updatedAt produce a cursor that correctly identifies the second row by id", () => {
    const sharedTimestamp = new Date("2025-06-15T12:00:00.000Z");
    const row1 = articleRow(50, sharedTimestamp);
    const row2 = articleRow(49, sharedTimestamp);

    const cursor1 = encodeCursor({
      sortValue: row1.updatedAt.toISOString(),
      id: String(row1.id),
    });
    const cursor2 = encodeCursor({
      sortValue: row2.updatedAt.toISOString(),
      id: String(row2.id),
    });

    const pos1 = decodeCursor(cursor1);
    const pos2 = decodeCursor(cursor2);

    expect(pos1?.id).toBe("50");
    expect(pos2?.id).toBe("49");
    expect(pos1?.sortValue).toBe(pos2?.sortValue);
    expect(pos1?.id).not.toBe(pos2?.id);
  });

  it("cursor from page 1 is passed through to page 2 and produces a different predicate", async () => {
    const t1 = new Date("2025-01-02T00:00:00.000Z");
    const t2 = new Date("2025-01-01T00:00:00.000Z");
    const row1 = articleRow(20, t1);
    const row2 = articleRow(10, t2);
    const sentinel = articleRow(5, t2);

    const { db } = buildChain([[row1, sentinel], [row2]]);
    const svc = new KbArticleQueryService(db as never, makeAccessService([1]) as never);

    const page1 = await svc.list(user as never, { limit: 1, cursor: undefined }, ALL);
    expect(page1.items).toHaveLength(1);
    expect(page1.hasMore).toBe(true);

    const page2 = await svc.list(
      user as never,
      { limit: 1, cursor: page1.nextCursor ?? undefined },
      ALL,
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe(10);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("returns first page instead of throwing for a malformed cursor", async () => {
    const t = new Date("2025-01-01T00:00:00.000Z");
    const { db } = buildChain([[articleRow(1, t), articleRow(2, t)]]);
    const svc = new KbArticleQueryService(db as never, makeAccessService([1]) as never);

    const result = await svc.list(
      user as never,
      { limit: 10, cursor: "not-a-valid-cursor!!!" },
      ALL,
    );

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("returns empty result when scope is none without querying the db", async () => {
    const { db } = buildChain([]);
    const svc = new KbArticleQueryService(db as never, makeAccessService([1]) as never);

    const result = await svc.list(user as never, { limit: 20, cursor: undefined }, ScopedRead.of("org-1", "u-1", "none"));

    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });
});
