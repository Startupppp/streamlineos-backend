import { BlogService } from "./blog.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";

describe("BlogService — admin list cap", () => {
  afterEach(() => jest.resetAllMocks());

  const QUERY = { page: 1, limit: 20 } as const;

  function makeSvc(findMany: jest.Mock, total = 0) {
    const db = {
      query: { blogPosts: { findMany } },
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ value: total }]) }) }),
    } as unknown as Db;

    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, factory: () => unknown) => factory()),
    } as unknown as CacheService;

    return new BlogService(db, cache);
  }

  it("applies BLOG_ADMIN_LIST_CAP limit to the admin posts query", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.listAdminPosts(QUERY);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(500);
  });

  it("returns the posts in a paged envelope with the real total", async () => {
    const post = { id: "1", title: "Hello", status: "published" };
    const findMany = jest.fn().mockResolvedValue([post]);
    const svc = makeSvc(findMany, 37);

    const result = await svc.listAdminPosts(QUERY);

    expect(result).toEqual({ items: [post], total: 37, page: 1, totalPages: 2 });
  });

  it("puts every filter in the cache key, so a filtered read cannot answer an unfiltered one", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const cachedVersioned = jest.fn().mockImplementation((_ns: string, _key: string, factory: () => unknown) => factory());
    const db = {
      query: { blogPosts: { findMany } },
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ value: 0 }]) }) }),
    } as unknown as Db;
    const svc = new BlogService(db, { cachedVersioned } as unknown as CacheService);

    await svc.listAdminPosts({ page: 1, limit: 20 });
    await svc.listAdminPosts({ page: 1, limit: 20, status: "draft" });
    await svc.listAdminPosts({ page: 1, limit: 20, search: "hello" });
    await svc.listAdminPosts({ page: 2, limit: 20 });

    const keys = cachedVersioned.mock.calls.map((c) => c[1] as string);
    expect(new Set(keys).size).toBe(4);
  });
});
