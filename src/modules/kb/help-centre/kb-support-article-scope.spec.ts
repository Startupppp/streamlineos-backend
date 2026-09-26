import { and, eq, is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAnalyticsService } from "./kb-analytics.service";
import { KbVerificationService } from "./kb-verification.service";

const dialect = new PgDialect();

type Rendered = { sql: string; params: unknown[] };

const EMPTY: Rendered = { sql: "", params: [] };

function render(value: unknown): Rendered {
  if (!is(value, SQL)) return EMPTY;
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: [...query.params] };
}

function readsPages(q: Rendered): boolean {
  return q.sql.toLowerCase().includes(`"kb_pages"`);
}

function readsArticles(q: Rendered): boolean {
  return q.sql.toLowerCase().includes("kb_articles");
}

function filtersToSupportArticles(q: Rendered): boolean {
  const lowered = q.sql.toLowerCase();
  if (!lowered.includes(`"kb_pages"."content_type"`)) return false;
  return lowered.includes("'support_article'") || q.params.includes("support_article");
}

function excludesSoftDeletedPages(q: Rendered): boolean {
  return q.sql.toLowerCase().includes(`"kb_pages"."deleted_at" is null`);
}

type Harness = {
  db: Db;
  wheres: Rendered[];
  projections: Record<string, unknown>[];
};

function makeHarness(rows: Record<string, unknown>[] = []): Harness {
  const wheres: Rendered[] = [];
  const projections: Record<string, unknown>[] = [];

  const chain = (): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    for (const step of ["orderBy", "groupBy", "limit", "leftJoin", "innerJoin"]) {
      link[step] = jest.fn(() => link);
    }
    link["offset"] = jest.fn(() => Promise.resolve(rows));
    link["then"] = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return link;
  };

  const db = {
    select: jest.fn((fields: Record<string, unknown>) => {
      projections.push(fields);
      return {
        from: jest.fn(() => ({
          where: jest.fn((clause: unknown) => {
            wheres.push(render(clause));
            return chain();
          }),
          leftJoin: jest.fn(() => ({
            where: jest.fn((clause: unknown) => {
              wheres.push(render(clause));
              return chain();
            }),
          })),
        })),
      };
    }),
  } as unknown as Db;

  return { db, wheres, projections };
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(eq(kbPages.orgId, "org-1")),
} as unknown as never;

const access = {
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1, 2]),
} as unknown as KbAccessService;

const USER = { userId: "user-1", orgId: "org-1", isOrgOwner: false } as unknown as CurrentUserContext;

function queueRow(trust: { verifiedAt: Date | null }): Record<string, unknown> {
  return {
    total: "3",
    id: 7,
    spaceId: 1,
    categoryId: null,
    title: "Refund policy",
    slug: "refund-policy",
    ownerMembershipId: null,
    reviewIntervalDays: 120,
    verifiedAt: trust.verifiedAt,
    updatedAt: new Date(0),
  };
}

function projectionOf(projections: Record<string, unknown>[], field: string): Rendered {
  const owner = projections.find((p) => field in p);
  return owner ? render(owner[field]) : EMPTY;
}

describe("help-centre analytics count only support articles", () => {
  it("reads every article statistic from kb_pages in one aggregate and never from kb_articles, because a second kb_pages read here returned per-page titles that overview never authorizes", async () => {
    const harness = makeHarness();

    await new KbAnalyticsService(harness.db, auth).overview("org-1", {});

    const pageQueries = harness.wheres.filter(readsPages);
    expect(pageQueries.length).toBe(1);
    expect(harness.wheres.some(readsArticles)).toBe(false);
  });

  it("excludes wiki pages from every article statistic", async () => {
    const harness = makeHarness();

    await new KbAnalyticsService(harness.db, auth).overview("org-1", {});

    const pageQueries = harness.wheres.filter(readsPages);
    expect(pageQueries.length).toBeGreaterThan(0);
    expect(pageQueries.every(filtersToSupportArticles)).toBe(true);
  });

  it("excludes soft-deleted pages from every article statistic", async () => {
    const harness = makeHarness();

    await new KbAnalyticsService(harness.db, auth).overview("org-1", {});

    const pageQueries = harness.wheres.filter(readsPages);
    expect(pageQueries.length).toBeGreaterThan(0);
    expect(pageQueries.every(excludesSoftDeletedPages)).toBe(true);
  });

  it("would report an org-only predicate as unscoped, so the two checks above can fail", () => {
    const orgOnly = render(and(eq(kbPages.orgId, "org-1"), eq(kbPages.status, "published")));

    expect(readsPages(orgOnly)).toBe(true);
    expect(filtersToSupportArticles(orgOnly)).toBe(false);
    expect(excludesSoftDeletedPages(orgOnly)).toBe(false);
  });

  it("derives the trust score from the page verification columns", async () => {
    const harness = makeHarness();

    await new KbAnalyticsService(harness.db, auth).overview("org-1", {});

    const verifiedPublished = projectionOf(harness.projections, "verifiedPublished");
    expect(verifiedPublished.sql.toLowerCase()).toContain(`"kb_pages"."trust_state"`);
    expect(verifiedPublished.sql.toLowerCase()).toContain(`"kb_pages"."verified_until"`);
    expect(verifiedPublished.sql.toLowerCase()).not.toContain("last_verified_at");
  });

  it("totals views with a null-safe sum, because a page that has never been viewed stores null and would otherwise make the org total null", async () => {
    const harness = makeHarness();

    await new KbAnalyticsService(harness.db, auth).overview("org-1", {});

    const totalViews = projectionOf(harness.projections, "totalViews");
    expect(totalViews.sql.toLowerCase()).toContain("coalesce");
    expect(totalViews.sql.toLowerCase()).toContain(`"kb_pages"."views"`);
  });

  it("ranks no top-article list at all, because overview never consults visiblePagePredicate and a per-page title here would name pages the caller cannot open", async () => {
    const harness = makeHarness();

    const result = await new KbAnalyticsService(harness.db, auth).overview(
      "org-1",
      {},
    );

    expect(result).not.toHaveProperty("topArticles");
    for (const projection of harness.projections) {
      expect(Object.keys(projection)).not.toContain("title");
    }
  });
});

describe("verification queue reads the same support-article scope", () => {
  it("restricts the queue to non-deleted support articles", async () => {
    const harness = makeHarness();

    await new KbVerificationService(harness.db, access).listDue(USER, 1, 20);

    const pageQueries = harness.wheres.filter(readsPages);
    expect(pageQueries.length).toBeGreaterThan(0);
    expect(pageQueries.every(filtersToSupportArticles)).toBe(true);
    expect(pageQueries.every(excludesSoftDeletedPages)).toBe(true);
    expect(harness.wheres.some(readsArticles)).toBe(false);
  });

  it("schedules due work from next_review_at and trust_state", async () => {
    const harness = makeHarness();

    await new KbVerificationService(harness.db, access).listDue(USER, 1, 20);

    const where = harness.wheres.filter(readsPages)[0];
    expect(where).toBeDefined();
    const lowered = where ? where.sql.toLowerCase() : "";
    expect(lowered).toContain(`"kb_pages"."next_review_at"`);
    expect(lowered).toContain(`"kb_pages"."trust_state"`);
    expect(lowered).not.toContain("last_verified_at");
  });

  it("reports lastVerifiedAt as the stored instant, not a window subtracted from verified_until", async () => {
    const verifiedAt = new Date("2026-06-30T00:00:00.000Z");
    const harness = makeHarness([queueRow({ verifiedAt })]);

    const result = await new KbVerificationService(harness.db, access).listDue(USER, 1, 20);

    expect(result.items[0]).toHaveProperty("lastVerifiedAt");
    expect(result.items[0]?.lastVerifiedAt).toEqual(verifiedAt);
  });

  it("reports lastVerifiedAt as null for a support article that was never verified", async () => {
    const harness = makeHarness([queueRow({ verifiedAt: null })]);

    const result = await new KbVerificationService(harness.db, access).listDue(USER, 1, 20);

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.lastVerifiedAt).toBeNull();
  });

  it("never leaks the window total or the page trust columns into a queue item", async () => {
    const harness = makeHarness([queueRow({ verifiedAt: new Date(0) })]);

    const result = await new KbVerificationService(harness.db, access).listDue(USER, 1, 20);

    expect(result.total).toBe(3);
    for (const item of result.items) {
      expect(item).not.toHaveProperty("total");
      expect(item).not.toHaveProperty("trustState");
      expect(item).not.toHaveProperty("verifiedUntil");
    }
  });
});
