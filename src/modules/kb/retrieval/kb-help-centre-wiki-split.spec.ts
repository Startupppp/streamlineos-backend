import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";

const ORG = "org-split";
const VECTOR = "[0.1,0.2]";
const PRINCIPAL = { userId: "user-1", membershipId: 1, roleSlugs: ["MEMBER"] };
const SHARED_ID = 77;

function makeStanding(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: 1,
    roleSlugs: ["MEMBER"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [1],
    accessibleProjectIds: [],
    permissionsVersion: 1,
    ...overrides,
  };
}

const dialect = new PgDialect();

const render = (cond: SQL): { text: string; params: unknown[] } => {
  const query = dialect.sqlToQuery(cond);
  return { text: query.sql, params: query.params };
};

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeHarness(rows: unknown[] = []) {
  const wheres: SQL[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn(() => chain),
    offset: jest.fn().mockResolvedValue(rows),
    limit: jest.fn(() => chain),
  };
  chain["limit"] = jest.fn(() => chain);
  chain["then"] = jest.fn((resolve: (value: unknown[]) => unknown) => resolve(rows));
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([{ id: SHARED_ID }]),
    transaction: jest.fn((callback: (tx: { execute: jest.Mock }) => Promise<unknown>) =>
      callback({ execute: jest.fn().mockResolvedValue([]) }),
    ),
  };
  return { db, wheres, candidates: new KbCandidateService(db as never) };
}

const ARTICLE_ALLOW_LIST = '"kb_pages"."content_type" = ';
const WIKI_DENY_OF_ARTICLES = '"kb_pages"."content_type" <> ';
const SOFT_DELETE = '"kb_pages"."deleted_at" is null';

describe("kb_pages holds help-centre articles and wiki pages, and a read must say which it wants", () => {
  it("the article keyword surface narrows to support_article by equality, never by a deny-list that would admit a future content type", async () => {
    const { wheres, candidates } = makeHarness();

    await candidates.articleKeywordCandidates(ORG, [1], "policy", 4, PRINCIPAL, null);

    const { text, params } = render(wheres[0] as SQL);
    expect(text).toContain(ARTICLE_ALLOW_LIST);
    expect(text).not.toContain(WIKI_DENY_OF_ARTICLES);
    expect(params).toContain("support_article");
  });

  it("the article keyword surface filters deleted_at, which kb_articles never had", async () => {
    const { wheres, candidates } = makeHarness();

    await candidates.articleKeywordCandidates(ORG, [1], "policy", 4, PRINCIPAL, null);

    expect(render(wheres[0] as SQL).text).toContain(SOFT_DELETE);
  });

  it("the article vector surface carries the same two narrowings, so semantic retrieval cannot reach a wiki page as an article", async () => {
    const { wheres, candidates } = makeHarness();

    await candidates.articleVectorCandidates(ORG, [1], VECTOR, 4, PRINCIPAL, null);

    const { text, params } = render(wheres[0] as SQL);
    expect(text).toContain(ARTICLE_ALLOW_LIST);
    expect(text).toContain(SOFT_DELETE);
    expect(params).toContain("support_article");
  });

  it("the wiki keyword surface excludes support_article, so one row cannot arrive as both an article and a page", async () => {
    const { wheres, candidates } = makeHarness();

    await candidates.pageKeywordCandidates(ORG, "policy", 4, sql`true`);

    const { text, params } = render(wheres[0] as SQL);
    expect(text).toContain(WIKI_DENY_OF_ARTICLES);
    expect(text).toContain(SOFT_DELETE);
    expect(params).toContain("support_article");
  });

  it("the wiki vector surface excludes support_article too", async () => {
    const { wheres, candidates } = makeHarness();

    await candidates.pageVectorCandidates(ORG, VECTOR, 4, chunkVisibleTo(makeStanding({ accessibleSpaceIds: [] })));

    const { text } = render(wheres[0] as SQL);
    expect(text).toContain(WIKI_DENY_OF_ARTICLES);
    expect(text).toContain(SOFT_DELETE);
  });

  it("the article surface pushes the kb_page_restrictions ACL and the wiki surface does not, which is why the wiki surface must refuse articles", async () => {
    const articles = makeHarness();
    const wiki = makeHarness();

    await articles.candidates.articleKeywordCandidates(ORG, [1], "policy", 4, PRINCIPAL, null);
    await wiki.candidates.pageKeywordCandidates(ORG, "policy", 4, sql`true`);

    expect(render(articles.wheres[0] as SQL).text).toContain("kb_page_restrictions");
    expect(render(wiki.wheres[0] as SQL).text).not.toContain("kb_page_restrictions");
  });
});

describe("KbSearchService.search is the help-centre surface, not the whole knowledge base", () => {
  function makeSearch(db: unknown, candidates: KbCandidateService): KbSearchService {
    return new KbSearchService(
      db as never,
      { recordDetached: jest.fn().mockResolvedValue(undefined) } as never,
      candidates,
      { scopeFor: jest.fn().mockResolvedValue("all") } as never,
      {
        visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
        resolveStanding: jest.fn().mockResolvedValue(makeStanding()),
        resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "hit" }),
        articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      } as never,
    );
  }

  it("narrows GET /kb/search to support_article, so a wiki page never renders as a help-centre result", async () => {
    const { db, wheres, candidates } = makeHarness();
    const scope = {
      denied: false,
      compose: (spec: { and?: SQL[] }, ok: (v: { sql: SQL }) => SQL) =>
        ok({ sql: sql`(${sql.join(spec.and ?? [], sql` and `)})` }),
    };

    await makeSearch(db, candidates).search(
      makeUser(),
      { q: "policy", page: 1, pageSize: 20 } as never,
      scope as never,
    );

    const rendered = wheres.map(render);
    const composed = rendered.map((r) => r.text).join("\u0000");
    const params = rendered.flatMap((r) => r.params);
    expect(composed).toContain(ARTICLE_ALLOW_LIST);
    expect(composed).toContain(SOFT_DELETE);
    expect(composed).not.toContain(WIKI_DENY_OF_ARTICLES);
    expect(params).toContain("support_article");
  });
});
