import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import { BlogService } from "./blog.service";

function makeSvc(findMany: jest.Mock) {
  const db = {
    query: {
      blogPosts: { findMany },
      blogCategories: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;

  const cache = {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: string, _key: string, factory: () => unknown) => factory(),
    ),
  } as unknown as CacheService;

  return new BlogService(db, cache);
}

function extractSqlText(node: unknown, visited = new Set<unknown>()): string[] {
  if (!node || typeof node !== "object") return [];
  if (visited.has(node)) return [];
  visited.add(node);

  const results: string[] = [];
  const rec = node as Record<string, unknown>;
  const chunks = rec["queryChunks"];

  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      if (
        chunk &&
        typeof chunk === "object" &&
        "value" in chunk &&
        Array.isArray((chunk as Record<string, unknown>)["value"])
      ) {
        for (const v of (chunk as Record<string, unknown[]>)["value"]) {
          if (typeof v === "string") results.push(v);
        }
      }
      results.push(...extractSqlText(chunk, visited));
    }
  }

  return results;
}

describe("D7 — blog search uses full-text search, not leading-wildcard ILIKE", () => {
  afterEach(() => jest.resetAllMocks());

  it("does not produce an ILIKE clause for the search term", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.getPublishedPosts({ search: "nestjs", featured: undefined });

    expect(findMany).toHaveBeenCalledTimes(1);
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown };
    const sqlTexts = extractSqlText(opts?.where);
    const combined = sqlTexts.join(" ");
    expect(combined.toUpperCase()).not.toContain("ILIKE");
  });

  it("produces a tsvector full-text search clause for the search term", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.getPublishedPosts({ search: "nestjs", featured: undefined });

    expect(findMany).toHaveBeenCalledTimes(1);
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown };
    const sqlTexts = extractSqlText(opts?.where);
    const combined = sqlTexts.join(" ");
    expect(combined.toLowerCase()).toContain("tsvector");
    expect(combined.toLowerCase()).toContain("plainto_tsquery");
  });

  it("passes the search term as a bound parameter, not interpolated into the SQL template text", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.getPublishedPosts({ search: "'; DROP TABLE blog_posts; --", featured: undefined });

    expect(findMany).toHaveBeenCalledTimes(1);
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown };
    const sqlTexts = extractSqlText(opts?.where);
    const combined = sqlTexts.join(" ");
    expect(combined).not.toContain("DROP TABLE");
  });

  it("skips the search condition when search is not provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(findMany);

    await svc.getPublishedPosts({ featured: undefined });

    expect(findMany).toHaveBeenCalledTimes(1);
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown };
    const sqlTexts = extractSqlText(opts?.where);
    const combined = sqlTexts.join(" ");
    expect(combined.toLowerCase()).not.toContain("tsvector");
  });
});
