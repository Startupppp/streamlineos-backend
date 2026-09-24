import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ScopedRead } from "../../access/scoped-read";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbArticleQueryService } from "./kb-article-query.service";
import { KbArticlesService } from "./kb-articles.service";
import { KbCommentsService } from "./kb-comments.service";
import { toArticleRow } from "./kb-article-columns";
import {
  articleNextReviewAt,
  articleVerifiedUntil,
  articleVisibilityToPage,
  pageVisibilityToArticle,
  supportArticlePredicate,
} from "./kb-article-page-scope";

const dialect = new PgDialect();
const ORG = "org-1";
const ARTICLE_ID = 5;

function render(where: SQL): string {
  return dialect.sqlToQuery(where).sql;
}

function renderedParams(where: SQL): unknown[] {
  return dialect.sqlToQuery(where).params;
}

function chain(rows: unknown[], captured: SQL[]): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = (): unknown => node;
  node.from = self;
  node.innerJoin = self;
  node.leftJoin = self;
  node.orderBy = self;
  node.set = self;
  node.values = self;
  node.returning = (): Promise<unknown[]> => Promise.resolve(rows);
  node.limit = (): Promise<unknown[]> => Promise.resolve(rows);
  node.where = (w: SQL): unknown => {
    captured.push(w);
    return node;
  };
  node.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve(rows).then(resolve);
  return node;
}

function actor(): CurrentUserContext {
  return { orgId: ORG, userId: "user-1", principal: humanSessionPrincipal(1, false) } as CurrentUserContext;
}

const WIKI_PAGE_ROW = {
  id: ARTICLE_ID,
  orgId: ORG,
  spaceId: 1,
  categoryId: null,
  title: "Q3 planning notes",
  slug: null,
  excerpt: null,
  content: { type: "doc", content: [{ type: "p", children: [{ text: "wiki" }] }] },
  contentText: "wiki",
  status: "published" as const,
  visibility: "org" as const,
  createdById: "user-9",
  ownerMembershipId: 4,
  trustState: "unverified" as const,
  verifiedAt: null,
  verifiedUntil: null,
  views: null,
  helpfulCount: null,
  notHelpfulCount: null,
  seoTitle: null,
  seoDescription: null,
  reviewIntervalDays: null,
  publishedAt: null,
  archivedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  aclRevision: 1,
  contentRevision: 1,
};

describe("the help centre reads support articles, never wiki pages", () => {
  it("names content_type and deleted_at in one predicate every kb_pages read shares", () => {
    const sql = render(supportArticlePredicate());

    expect(sql).toContain('"content_type"');
    expect(sql).toContain('"deleted_at" is null');
    expect(renderedParams(supportArticlePredicate())).toContain("support_article");
  });

  it("GET /kb/articles filters kb_pages down to undeleted support articles", async () => {
    const captured: SQL[] = [];
    const db = { select: jest.fn(() => chain([], captured)) };
    const access = { getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]) };
    const svc = new KbArticleQueryService(db as never, access as never);

    await svc.list(actor(), { limit: 20 }, ScopedRead.of(ORG, "user-1", "all"));

    expect(captured).toHaveLength(1);
    expect(render(captured[0])).toContain('"deleted_at" is null');
    expect(renderedParams(captured[0])).toContain("support_article");
  });

  it("GET /kb/articles/:articleId refuses a wiki page id, because the predicate is in the WHERE", async () => {
    const captured: SQL[] = [];
    const db = { select: jest.fn(() => chain([], captured)) };
    const access = { assertCanViewArticle: jest.fn() };
    const svc = new KbArticlesService(db as never, access as never, {} as never);

    await expect(svc.get(actor(), ARTICLE_ID)).rejects.toThrow("Article not found");

    expect(renderedParams(captured[0])).toContain("support_article");
    expect(render(captured[0])).toContain('"deleted_at" is null');
    expect(access.assertCanViewArticle).not.toHaveBeenCalled();
  });

  it("carries the same predicate into every article mutation, so a wiki page cannot be archived through /kb/articles", async () => {
    const captured: SQL[] = [];
    const node = chain([], captured);
    const db = {
      update: jest.fn(() => node),
      transaction: (cb: (tx: unknown) => unknown): unknown => cb({ update: jest.fn(() => node) }),
    };
    const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) };
    const svc = new KbArticlesService(db as never, access as never, {} as never);

    await expect(svc.archive(actor(), ARTICLE_ID)).rejects.toThrow("Article not found");

    expect(renderedParams(captured[0])).toContain("support_article");
  });

  it("resolves a comment only when its page is a support article, so /kb/comments cannot reach a wiki comment", async () => {
    const captured: SQL[] = [];
    const db = { select: jest.fn(() => chain([], captured)) };
    const svc = new KbCommentsService(db as never, {} as never, {} as never);

    await expect(svc.resolve(actor(), 77)).rejects.toThrow("Comment not found");

    expect(renderedParams(captured[0])).toContain("support_article");
  });
});

describe("the article shape a kb_pages row leaves the module in", () => {
  it("maps createdById onto authorId and the jsonb document onto the content string", () => {
    const row = toArticleRow(WIKI_PAGE_ROW);

    expect(row.authorId).toBe("user-9");
    expect(row.content).toBe(JSON.stringify(WIKI_PAGE_ROW.content));
    expect(row.contentText).toBe("wiki");
  });

  it("substitutes the defaults a nullable kb_pages column can hold for a NOT NULL contract field", () => {
    const row = toArticleRow(WIKI_PAGE_ROW);

    expect(row.slug).toBe("");
    expect(row.views).toBe(0);
    expect(row.helpfulCount).toBe(0);
    expect(row.notHelpfulCount).toBe(0);
  });

  it("collapses the three page visibilities onto the two the article contract publishes", () => {
    expect(pageVisibilityToArticle("public")).toBe("public");
    expect(pageVisibilityToArticle("org")).toBe("internal");
    expect(pageVisibilityToArticle("private")).toBe("internal");
    expect(articleVisibilityToPage("public")).toBe("public");
    expect(articleVisibilityToPage("internal")).toBe("org");
  });

  it("holds the verified window fixed while nextReviewAt tracks reviewIntervalDays", () => {
    const verifiedAt = new Date("2026-03-01T12:00:00.000Z");
    const expectedUntil = articleVerifiedUntil(verifiedAt);

    for (const reviewIntervalDays of [null, 7, 30, 120, 365]) {
      expect(articleVerifiedUntil(verifiedAt)).toEqual(expectedUntil);

      const nextReviewAt = articleNextReviewAt(verifiedAt, reviewIntervalDays);
      if (reviewIntervalDays === null) {
        expect(nextReviewAt).toBeNull();
        continue;
      }
      expect(nextReviewAt).toEqual(
        new Date(verifiedAt.getTime() + reviewIntervalDays * 24 * 60 * 60 * 1000),
      );
    }
  });
});
