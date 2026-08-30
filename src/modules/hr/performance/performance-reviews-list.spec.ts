process.env.APP_URL ??= "http://localhost:1000";

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { PerformanceReviewsService } from "./performance-reviews.service";
import { listPerformanceReviewsSchema } from "./dto/performance.schemas";
import { encodeCursor } from "../../../common/pagination/cursor";

const dialect = new PgDialect();

type CapturedQuery = { where?: SQL; orderBy?: unknown[]; limit?: number };

function buildService(rows: Record<string, unknown>[]) {
  const captured: CapturedQuery = {};
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (where: SQL) => {
      captured.where = where;
      return chain;
    },
    orderBy: (...orderBy: unknown[]) => {
      captured.orderBy = orderBy;
      return chain;
    },
    limit: (limit: number) => {
      captured.limit = limit;
      return Promise.resolve(rows);
    },
  };
  const db = { select: () => chain };
  const service = new PerformanceReviewsService(
    db as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, captured };
}

function row(id: number, secondsAgo: number) {
  return {
    id,
    orgId: "org-1",
    userId: `subject-${id}`,
    reviewerId: "reviewer-1",
    cycleId: null,
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    status: "DRAFT",
    overallRating: null,
    createdAt: new Date(Date.UTC(2026, 7, 20, 9, 0, 0) - secondsAgo * 1000),
    updatedAt: new Date(Date.UTC(2026, 7, 20, 9, 0, 0) - secondsAgo * 1000),
    user: null,
    reviewer: null,
    cycle: null,
  };
}

const query = (overrides: Record<string, unknown> = {}) =>
  listPerformanceReviewsSchema.parse(overrides);

function whereSql(captured: CapturedQuery) {
  if (!captured.where) throw new Error("no where clause captured");
  return dialect.sqlToQuery(captured.where);
}

describe("PerformanceReviewsService.listReviews — scope is a predicate, not a filter applied afterwards", () => {
  it("denies a caller with no scope in SQL rather than reading rows first", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews("org-1", "actor-1", "none", query());

    expect(whereSql(captured).sql).toContain("false");
  });

  it("binds an own-scope caller to their own reviews", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews("org-1", "actor-1", "own", query());

    const built = whereSql(captured);
    expect(built.sql).toContain('"performance_reviews"."user_id" =');
    expect(built.params).toContain("actor-1");
  });

  it("keeps the scope predicate when an employee filter is supplied, so the filter can only narrow", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews(
      "org-1",
      "actor-1",
      "own",
      query({ userId: "someone-else" }),
    );

    const built = whereSql(captured);
    expect(built.params).toContain("actor-1");
    expect(built.params).toContain("someone-else");
  });

  it("always scopes to the caller's organization", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews("org-1", "actor-1", "all", query());

    const built = whereSql(captured);
    expect(built.sql).toContain('"performance_reviews"."org_id" =');
    expect(built.params).toContain("org-1");
  });
});

describe("PerformanceReviewsService.listReviews — keyset pagination", () => {
  it("over-fetches by exactly one row to decide hasMore without a second count", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews("org-1", "actor-1", "all", query({ limit: 25 }));

    expect(captured.limit).toBe(26);
  });

  it("orders by the requested sort and the unique tie-breaker", async () => {
    const { service, captured } = buildService([]);

    await service.listReviews("org-1", "actor-1", "all", query());

    expect(captured.orderBy).toHaveLength(2);
    const rendered = captured.orderBy!.map((part) => dialect.sqlToQuery(part as SQL).sql);
    expect(rendered[0]).toContain('"performance_reviews"."created_at" desc');
    expect(rendered[1]).toContain('"performance_reviews"."id" desc');
  });

  it("compares the cursor as one tuple so a shared timestamp cannot skip or repeat a row", async () => {
    const { service, captured } = buildService([]);
    const cursor = encodeCursor({ sortValue: "2026-08-20T09:00:00.000Z", id: "412" });

    await service.listReviews("org-1", "actor-1", "all", query({ cursor }));

    const built = whereSql(captured);
    expect(built.sql).toContain(
      '("performance_reviews"."created_at", "performance_reviews"."id") < (',
    );
    expect(built.params).toContain(412);
    expect(built.params.some((param) => param instanceof Date)).toBe(false);
  });

  it("binds a date sort as a string the date column can serialise", async () => {
    const { service, captured } = buildService([]);
    const cursor = encodeCursor({ sortValue: "2026-01-01", id: "412" });

    await service.listReviews(
      "org-1",
      "actor-1",
      "all",
      query({ cursor, sortField: "periodStart" }),
    );

    const built = whereSql(captured);
    expect(built.sql).toContain(
      '("performance_reviews"."period_start", "performance_reviews"."id") < (',
    );
    expect(built.params).toContain("2026-01-01");
    expect(built.params).toContain(412);
  });

  it("takes the next cursor from the last row it keeps, never from the discarded sentinel", async () => {
    const rows = [row(10, 0), row(9, 60), row(8, 120)];
    const { service } = buildService(rows);

    const page = await service.listReviews(
      "org-1",
      "actor-1",
      "all",
      query({ limit: 2 }),
    );

    expect(page.data.map((r) => r.id)).toEqual([10, 9]);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toBe(
      encodeCursor({ sortValue: rows[1]!.createdAt.toISOString(), id: "9" }),
    );
  });

  it("reports the end of the list when no sentinel row comes back", async () => {
    const { service } = buildService([row(10, 0), row(9, 60)]);

    const page = await service.listReviews(
      "org-1",
      "actor-1",
      "all",
      query({ limit: 2 }),
    );

    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });
});

describe("listPerformanceReviewsSchema", () => {
  it("caps the page size at the platform ceiling instead of rejecting the request", () => {
    expect(listPerformanceReviewsSchema.parse({ limit: 5000 }).limit).toBe(100);
  });

  it("rejects a sort field that is not in the allowlist", () => {
    expect(listPerformanceReviewsSchema.safeParse({ sortField: "overallRating" }).success).toBe(false);
  });

  it("defaults to newest first", () => {
    const parsed = listPerformanceReviewsSchema.parse({});
    expect(parsed.sortField).toBe("createdAt");
    expect(parsed.sortDir).toBe("desc");
  });
});
