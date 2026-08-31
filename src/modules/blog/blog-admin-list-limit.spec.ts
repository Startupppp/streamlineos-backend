import { BlogService } from "./blog.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";

describe("BlogService — admin list cap", () => {
  afterEach(() => jest.resetAllMocks());

  function makeSvc(findMany: jest.Mock) {
    const db = {
      query: { blogPosts: { findMany } },
    } as unknown as Db;

    const cache = {
      cachedVersioned: jest.fn().mockImplementation((_ns: string, _key: string, factory: () => unknown) => factory()),
    } as unknown as CacheService;

    return new BlogService(db, cache);
  }

  it("applies BLOG_ADMIN_LIST_CAP limit to the admin posts query", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.listAdminPosts();

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(500);
  });

  it("returns the posts array from the query", async () => {
    const post = { id: "1", title: "Hello", status: "published" };
    const findMany = jest.fn().mockResolvedValue([post]);
    const svc = makeSvc(findMany);

    const result = await svc.listAdminPosts();

    expect(result).toEqual([post]);
  });
});
