import {
  kbSourcesListQuerySchema,
  type KbSourcesListQuery,
} from "./dto/kb-sources.schemas";
import { searchPagesSchema, KB_PAGE_SEARCH_MAX_LIMIT } from "./dto/kb-pages.schemas";
import { KbSourcesService } from "./kb-sources.service";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";

/**
 * Two KB lists answered a hard cap with no way past it and no signal that anything was
 * cut.
 *
 *   GET /kb/sources      .limit(100), plain array — a tenant past 100 sources could never
 *                        reach the rest from any client.
 *   GET /kb/pages/search .limit(20), plain array — a query matching 500 pages was
 *                        indistinguishable from one matching 20.
 *
 * Neither is a page size; both are silent truncation. Sources is a keyset page now; page
 * search stays a bounded top-N (paging a `ts_rank` ordering means re-ranking every page)
 * but declares its ceiling and reports the cut.
 */

function makeSourcesDb(rows: Array<{ id: number; createdAt: Date }>): {
  db: Db;
  limits: number[];
} {
  const limits: number[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              limits.push(n);
              return rows.slice(0, n);
            },
          }),
        }),
      }),
    }),
  } as unknown as Db;
  return { db, limits };
}

function service(db: Db): KbSourcesService {
  return new KbSourcesService(
    db,
    {} as never,
    {} as never,
    {} as never,
  );
}

function query(over: Partial<KbSourcesListQuery> = {}): KbSourcesListQuery {
  return kbSourcesListQuerySchema.parse({ limit: 50, ...over });
}

describe("GET /kb/sources — a cursor, not a ceiling", () => {
  it("no longer caps at a fixed 100 with no way past it", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "kb-sources.service.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("MAX_SOURCES");
    expect(source).toContain("buildCursorPage");
  });

  it("over-fetches one row so hasMore costs no second query", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: 100 - i,
      createdAt: new Date(1_700_000_000_000 - i * 1000),
    }));
    const { db, limits } = makeSourcesDb(rows);

    const page = await service(db).list("org-1", query({ limit: 50 }));

    expect(limits).toEqual([51]);
    expect(page.data).toHaveLength(50);
    expect(page.pagination.hasMore).toBe(true);
  });

  /**
   * The sentinel bug: a next cursor taken from the DISCARDED row makes an exclusive bound
   * skip it permanently. It must come from the last row the caller keeps.
   */
  it("takes the next cursor from the last row kept, never from the sentinel", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: 100 - i,
      createdAt: new Date(1_700_000_000_000 - i * 1000),
    }));
    const { db } = makeSourcesDb(rows);

    const page = await service(db).list("org-1", query({ limit: 50 }));
    const position = decodeCursor(page.pagination.nextCursor);

    const lastKept = page.data[page.data.length - 1];
    if (!lastKept || !position) throw new Error("expected a page and a cursor");
    expect(position.id).toBe(String(lastKept.id));
    expect(position.id).not.toBe(String(rows[50]?.id));
  });

  it("reports no next page when the result fits", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: 3 - i,
      createdAt: new Date(1_700_000_000_000 - i * 1000),
    }));
    const { db } = makeSourcesDb(rows);

    const page = await service(db).list("org-1", query({ limit: 50 }));

    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  /**
   * `created_at` carries no uniqueness, so the tie-breaker has to be in the cursor or two
   * sources uploaded in the same millisecond straddle a page boundary forever.
   */
  it("carries the id tie-breaker alongside the timestamp", async () => {
    const sameInstant = new Date(1_700_000_000_000);
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: 10 - i, createdAt: sameInstant }));
    const { db } = makeSourcesDb(rows);

    const page = await service(db).list("org-1", query({ limit: 5 }));
    const position = decodeCursor(page.pagination.nextCursor);

    if (!position) throw new Error("expected a cursor");
    expect(position.sortValue).toBe(sameInstant.toISOString());
    expect(position.id).toBe("6");
  });

  it("refuses a page size above the hard cap rather than honouring it", () => {
    expect(() => kbSourcesListQuerySchema.parse({ limit: 5000 })).toThrow();
    expect(kbSourcesListQuerySchema.parse({}).limit).toBe(50);
  });
});

describe("GET /kb/pages/search — a declared ceiling, not a buried one", () => {
  it("states the ceiling as a constant instead of a bare .limit()", () => {
    expect(KB_PAGE_SEARCH_MAX_LIMIT).toBe(20);
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "kb-pages.service.ts"),
      "utf8",
    ) as string;
    expect(source).not.toMatch(/^\s*\.limit\(20\)/m);
    expect(source).toMatch(/\.limit\(limit \+ 1\)/);
    expect(source).toContain("hasMore");
  });

  it("accepts a smaller limit and refuses one above the ceiling", () => {
    expect(searchPagesSchema.parse({ q: "x", limit: 5 }).limit).toBe(5);
    expect(searchPagesSchema.parse({ q: "x" }).limit).toBe(KB_PAGE_SEARCH_MAX_LIMIT);
    expect(() => searchPagesSchema.parse({ q: "x", limit: 200 })).toThrow();
  });
});
