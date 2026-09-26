import { KbAnalyticsService } from "./kb-analytics.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { sql } from "drizzle-orm";

const mockDb = {
  select: jest.fn(),
};

const mockAuth = {
  visiblePagePredicate: jest.fn(),
};

function makeService(): KbAnalyticsService {
  return new KbAnalyticsService(mockDb as never, mockAuth as unknown as KnowledgeAuthorizationService);
}

const baseUser = { orgId: "org-1", userId: "u-1", membershipId: "m-1" } as never;

function chainFor(rows: unknown[]) {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
    leftJoin: jest.fn().mockReturnThis(),
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gaps() cursor pagination", () => {
  it("returns hasMore=false and nextCursor=null when result fits in limit", async () => {
    const rows = [
      { query: "how to reset password", count: 10, lastOccurredAt: new Date("2024-01-01") },
      { query: "export to pdf", count: 5, lastOccurredAt: new Date("2024-01-02") },
    ];
    mockDb.select.mockReturnValue(chainFor(rows));

    const service = makeService();
    const result = await service.gaps(baseUser, { limit: 5 });

    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.data).toHaveLength(2);
  });

  it("returns hasMore=true and a nextCursor when result exceeds limit", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      query: `query-${i}`,
      count: 10 - i,
      lastOccurredAt: new Date("2024-01-01"),
    }));
    mockDb.select.mockReturnValue(chainFor(rows));

    const service = makeService();
    const result = await service.gaps(baseUser, { limit: 5 });

    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toBeTruthy();
    expect(result.data).toHaveLength(5);
  });

  it("passes cursor and limit into query chain", async () => {
    const chain = chainFor([]);
    mockDb.select.mockReturnValue(chain);

    const service = makeService();
    await service.gaps(baseUser, { limit: 10, cursor: undefined });

    expect(chain.having).toHaveBeenCalled();
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(11);
  });

  it("encodes query string into nextCursor tuple so next page can be decoded", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      query: `query-${i}`,
      count: 10 - i,
      lastOccurredAt: new Date("2024-01-01"),
    }));
    mockDb.select.mockReturnValue(chainFor(rows));

    const service = makeService();
    const result = await service.gaps(baseUser, { limit: 3 });

    expect(result.pagination.hasMore).toBe(true);
    expect(typeof result.pagination.nextCursor).toBe("string");
  });
});

describe("gapRelatedPages() drill-down privacy", () => {
  it("applies visiblePagePredicate so hidden pages are not surfaced", async () => {
    const sentinelPredicate = sql`1=1`;
    mockAuth.visiblePagePredicate.mockResolvedValue(sentinelPredicate);

    const chain = chainFor([
      { id: 1, title: "Visible Page", status: "published", updatedAt: new Date("2024-01-01") },
    ]);
    mockDb.select.mockReturnValue(chain);

    const service = makeService();
    const result = await service.gapRelatedPages(baseUser, { query: "reset password", limit: 10 });

    expect(mockAuth.visiblePagePredicate).toHaveBeenCalledWith(baseUser, "view");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].title).toBe("Visible Page");
  });

  it("a page the viewer cannot see does not appear in drill-down results", async () => {
    const noAccessPredicate = sql`1=0`;
    mockAuth.visiblePagePredicate.mockResolvedValue(noAccessPredicate);

    const chain = chainFor([]);
    mockDb.select.mockReturnValue(chain);

    const service = makeService();
    const result = await service.gapRelatedPages(baseUser, { query: "secret topic", limit: 10 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("returns hasMore=true and nextCursor when drill-down has more pages", async () => {
    mockAuth.visiblePagePredicate.mockResolvedValue(sql`1=1`);

    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      title: `Page ${i + 1}`,
      status: "published",
      updatedAt: new Date(2024, 0, i + 1),
    }));
    const chain = chainFor(rows);
    mockDb.select.mockReturnValue(chain);

    const service = makeService();
    const result = await service.gapRelatedPages(baseUser, { query: "how to", limit: 5 });

    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toBeTruthy();
    expect(result.data).toHaveLength(5);
  });

  it("passes the gap query to websearch_to_tsquery so LIKE wildcards in user text are treated as literals, not pattern characters", async () => {
    mockAuth.visiblePagePredicate.mockResolvedValue(sql`1=1`);

    const chain = chainFor([]);
    mockDb.select.mockReturnValue(chain);

    const service = makeService();
    await service.gapRelatedPages(baseUser, { query: "100% SLA guarantee", limit: 10 });

    expect(chain.where).toHaveBeenCalled();
    const whereCondition = chain.where.mock.calls[0][0];
    expect(whereCondition).toBeDefined();

    const seen = new WeakSet<object>();
    function collectStrings(value: unknown): string[] {
      if (typeof value === "string") return [value];
      if (value === null || typeof value !== "object") return [];
      if (seen.has(value)) return [];
      seen.add(value);
      return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
    }

    const sqlStrings = collectStrings(whereCondition);
    expect(sqlStrings.some((s) => s.includes("websearch_to_tsquery"))).toBe(true);
    expect(sqlStrings.every((s) => !s.toLowerCase().includes(" like "))).toBe(true);
  });
});
