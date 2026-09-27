import type { Db } from "../../../db/drizzle.module";
import { KbArticleQueryService } from "./kb-article-query.service";
import { decodeCursor } from "../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

function buildVersionChain(rows: unknown[] = []) {
  let limitArg: number | undefined;

  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };

  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockImplementation((n: number) => {
    limitArg = n;
    return Promise.resolve(rows);
  });

  const db = {
    select: jest.fn().mockReturnValue(chain),
  };

  return { db, chain, getLimitArg: () => limitArg };
}

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", isOwner: false } as never;
}

function makeAccess() {
  return {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
    assertArticleViewable: jest.fn().mockResolvedValue(undefined),
  } as never;
}

function versionRow(versionNumber: number, id = versionNumber * 10) {
  return {
    id,
    orgId: "org-1",
    pageId: 42,
    versionNumber,
    title: `v${versionNumber}`,
    content: null,
    excerpt: null,
    changeSummary: null,
    authorId: null,
    authorMembershipId: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

describe("KbArticleQueryService.listVersions — BE-25 cursor pagination", () => {
  it("returns hasMore: true and a non-null nextCursor when sentinel row is present", async () => {
    const rows = [versionRow(5), versionRow(4), versionRow(3)];
    const { db } = buildVersionChain(rows);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    const result = await svc.listVersions(makeUser(), 42, undefined, 2);

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(result.items).toHaveLength(2);
  });

  it("returns hasMore: false and nextCursor: null on the last page", async () => {
    const rows = [versionRow(2), versionRow(1)];
    const { db } = buildVersionChain(rows);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    const result = await svc.listVersions(makeUser(), 42, undefined, 10);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(2);
  });

  it("cursor from page 1 encodes the versionNumber of the last returned row", async () => {
    const rows = [versionRow(5), versionRow(4), versionRow(3)];
    const { db } = buildVersionChain(rows);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    const page1 = await svc.listVersions(makeUser(), 42, undefined, 2);

    expect(page1.nextCursor).not.toBeNull();
    const pos = decodeCursor(page1.nextCursor);
    expect(pos).not.toBeNull();
    expect(pos?.sortValue).toBe("4");
  });

  it("fetches limit + 1 rows to detect hasMore without a count query", async () => {
    const { db, getLimitArg } = buildVersionChain([]);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    await svc.listVersions(makeUser(), 42, undefined, 10);

    expect(getLimitArg()).toBe(11);
  });

  it("caps the requested limit at PAGE_SIZE_CAP — satisfying BE-24", async () => {
    const { db, getLimitArg } = buildVersionChain([]);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    await svc.listVersions(makeUser(), 42, undefined, 9999);

    expect(getLimitArg()).toBe(PAGE_SIZE_CAP + 1);
  });

  it("returns nextCursor: null (not undefined) when there are no more pages — cursor-undefined safety", async () => {
    const { db } = buildVersionChain([versionRow(1)]);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    const result = await svc.listVersions(makeUser(), 42, undefined, 10);

    expect(result.nextCursor).toBeNull();
    expect(result.nextCursor).not.toBeUndefined();
  });

  it("maps articleId correctly from pageId in the version row", async () => {
    const { db } = buildVersionChain([versionRow(3)]);
    const svc = new KbArticleQueryService(db as unknown as Db, makeAccess());

    const result = await svc.listVersions(makeUser(), 42, undefined, 10);

    expect(result.items[0]?.articleId).toBe(42);
  });
});
