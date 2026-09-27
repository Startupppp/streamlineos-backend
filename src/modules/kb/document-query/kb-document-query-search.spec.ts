import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import { KbDocumentQueryService } from "./kb-document-query.service";

const dialect = new PgDialect();
const ORG = "org-search-q";

function actor(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "session",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

const FAKE_ARTICLE_ROW = {
  id: 1,
  title: "t",
  slug: null,
  spaceId: 1,
  excerpt: null,
  status: "published" as const,
  updatedAt: new Date(),
};

const FAKE_PAGE_ROW = {
  id: 2,
  title: "t",
  spaceId: 1,
  status: "published",
  updatedAt: new Date(),
};

function makeHarness(rowsPerBranch: number) {
  const articleWheres: SQL[] = [];
  const pageWheres: SQL[] = [];
  let selectCallCount = 0;

  function buildChain(wheres: SQL[], rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: (cond: SQL) => {
        wheres.push(cond);
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    });
    return chain;
  }

  const db = {
    select: jest.fn(() => {
      selectCallCount += 1;
      const isArticle = selectCallCount % 2 === 1;
      return isArticle
        ? buildChain(articleWheres, Array(rowsPerBranch).fill(FAKE_ARTICLE_ROW))
        : buildChain(pageWheres, Array(rowsPerBranch).fill(FAKE_PAGE_ROW));
    }),
  } as unknown as Db;

  const access = {
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;

  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
    assertPageAccess: jest.fn(),
    resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [1] }),
  };

  const service = new KbDocumentQueryService(db, access, auth as never);
  return { service, articleWheres, pageWheres };
}

describe("KbDocumentQueryService — no leading-wildcard scan (BE-49)", () => {
  it("page predicate produces SQL (positive control: where clause is captured)", async () => {
    const { service, pageWheres } = makeHarness(0);
    await service.searchDocuments(actor(), "hello", 10);
    expect(pageWheres).toHaveLength(1);
  });

  it("page predicate uses tsquery (@@ operator) and not ILIKE", async () => {
    const { service, pageWheres } = makeHarness(0);
    await service.searchDocuments(actor(), "hello", 10);
    const { sql: s } = dialect.sqlToQuery(pageWheres[0]!);
    expect(s).toContain("@@");
    expect(s).not.toMatch(/ILIKE/i);
  });

  it("page predicate — user query arrives as a bound parameter, not interpolated into SQL text", async () => {
    const { service, pageWheres } = makeHarness(0);
    const TERM = "uniquepageterm987";
    await service.searchDocuments(actor(), TERM, 10);
    const { params } = dialect.sqlToQuery(pageWheres[0]!);
    expect(params).toContain(TERM);
  });

  it("article predicate produces SQL (positive control: where clause is captured)", async () => {
    const { service, articleWheres } = makeHarness(0);
    await service.searchDocuments(actor(), "hello", 10);
    expect(articleWheres).toHaveLength(1);
  });

  it("article predicate uses tsquery (@@ operator) and not ILIKE", async () => {
    const { service, articleWheres } = makeHarness(0);
    await service.searchDocuments(actor(), "hello", 10);
    const { sql: s } = dialect.sqlToQuery(articleWheres[0]!);
    expect(s).toContain("@@");
    expect(s).not.toMatch(/ILIKE/i);
  });

  it("article predicate — user query arrives as a bound parameter, not interpolated into SQL text", async () => {
    const { service, articleWheres } = makeHarness(0);
    const TERM = "uniquearticleterm123";
    await service.searchDocuments(actor(), TERM, 10);
    const { params } = dialect.sqlToQuery(articleWheres[0]!);
    expect(params).toContain(TERM);
  });
});

describe("KbDocumentQueryService — search syntax escaping", () => {
  it("percent signs in the query do not inject an ILIKE wildcard (positive control: where is captured)", async () => {
    const { service, pageWheres } = makeHarness(0);
    await service.searchDocuments(actor(), "100%", 10);
    expect(pageWheres).toHaveLength(1);
  });

  it("percent signs arrive as a bound parameter, not as SQL LIKE wildcards", async () => {
    const { service, pageWheres } = makeHarness(0);
    const EVIL = "100%";
    await service.searchDocuments(actor(), EVIL, 10);
    const { sql: s, params } = dialect.sqlToQuery(pageWheres[0]!);
    expect(s).not.toMatch(/ILIKE/i);
    expect(params).toContain(EVIL);
  });

  it("underscores arrive as a bound parameter, not as LIKE single-char wildcards", async () => {
    const { service, pageWheres } = makeHarness(0);
    const EVIL = "my_field";
    await service.searchDocuments(actor(), EVIL, 10);
    const { sql: s, params } = dialect.sqlToQuery(pageWheres[0]!);
    expect(s).not.toMatch(/ILIKE/i);
    expect(params).toContain(EVIL);
  });

  it("tsquery operator characters arrive as a bound parameter, not as raw tsquery operators", async () => {
    const { service, pageWheres } = makeHarness(0);
    const EVIL = "a & b";
    await service.searchDocuments(actor(), EVIL, 10);
    const { sql: s, params } = dialect.sqlToQuery(pageWheres[0]!);
    expect(s).toContain("@@");
    expect(params).toContain(EVIL);
  });
});

describe("KbDocumentQueryService — merged result cap (BE-24)", () => {
  it("returns rows when branches have results (positive control: cap test is not vacuous)", async () => {
    const LIMIT = 5;
    const { service } = makeHarness(LIMIT);
    const hits = await service.searchDocuments(actor(), "test", LIMIT);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("merged result is capped at the requested limit even when both branches return full pages", async () => {
    const LIMIT = 5;
    const { service } = makeHarness(LIMIT);
    const hits = await service.searchDocuments(actor(), "test", LIMIT);
    expect(hits.length).toBeLessThanOrEqual(LIMIT);
  });
});
