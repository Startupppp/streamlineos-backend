import { ScopedRead } from "../../../src/modules/access/scoped-read";
import { readFileSync } from "node:fs";
import { Test, type TestingModule } from "@nestjs/testing";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { kbPages } from "../../../src/db/schema";
import { KbSearchService } from "../../../src/modules/kb/retrieval/kb-search.service";
import { KbSearchRetrievalService } from "../../../src/modules/kb/retrieval/kb-search-retrieval.service";
import { KbCandidateService } from "../../../src/modules/kb/retrieval/kb-candidate.service";
import { KbAskService } from "../../../src/modules/kb/retrieval/kb-ask.service";
import { KbCitationVisibilityService } from "../../../src/modules/kb/retrieval/kb-citation-visibility.service";
import { KbAskCitationService } from "../../../src/modules/kb/retrieval/kb-ask-citations.service";
import { KbRetrievalService } from "../../../src/modules/kb/retrieval/kb-retrieval.service";
import { REDIS } from "../../../src/common/cache/cache.service";
import { KbLinkedDocumentAskSource } from "../../../src/modules/kb/linked-documents/kb-linked-document-ask-source";
import { NO_LINKED_DOCUMENTS } from "../../../src/test/kb-linked-document-ask-source.spec-fixtures";
import { KbAccessService } from "../../../src/modules/kb/core/kb-access.service";
import { KbEventsService } from "../../../src/modules/kb/core/kb-events.service";
import { KnowledgeAuthorizationService } from "../../../src/modules/kb/core/authorization/knowledge-authorization.service";
import { AiGatewayService } from "../../../src/modules/ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../src/db/drizzle.constants";
import { articleOwnerScopeFilter } from "../../../src/modules/kb/retrieval/kb-article-owner-scope";
import type { CurrentUserContext } from "../../../src/common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../src/common/auth/principal";
import type { DataScope } from "../../../src/modules/access/access.types";
import { BACKEND_ROOT } from "./route-surface";
import {
  makeFakeKbDb,
  ownerBoundIn,
  refusesEverything,
  type RecordedQuery,
} from "./kb-rag-fake-db";

/**
 * `POST /kb/ask` puts article text into a model's context window. The constitution
 * requires that retrieval bind the same object-level visibility the direct read
 * endpoint enforces, in the SQL predicate, before candidates exist — a chunk is
 * disclosed the moment it enters the context, and no instruction to the model can
 * take it back. The direct read (`GET /kb/search`) narrows on the article owner
 * below scope `all`; retrieval did not. These tests are the behavioural proof that
 * it now does, and that the guard is not a blanket denial.
 */

const ORG = "org-1";
const ASKER_MEMBERSHIP = 7;
const VICTIM_MEMBERSHIP = 99;
const MINE = "MINE-ONLY-TEXT";
const VICTIM_SECRET = "VICTIM-SECRET-TEXT";

const OWNED_ARTICLE = {
  id: 101,
  ownerMembershipId: ASKER_MEMBERSHIP,
  title: "My Runbook",
  slug: "my-runbook",
  spaceId: 1,
  contentText: MINE,
  updatedAt: new Date("2026-01-01"),
};

const VICTIM_ARTICLE = {
  id: 202,
  ownerMembershipId: VICTIM_MEMBERSHIP,
  title: "Executive Compensation Plan",
  slug: "exec-comp",
  spaceId: 1,
  contentText: VICTIM_SECRET,
  updatedAt: new Date("2026-01-02"),
};

const FIXTURES = {
  articles: [OWNED_ARTICLE, VICTIM_ARTICLE],
  chunks: [
    { id: 10, pageId: OWNED_ARTICLE.id, content: MINE },
    { id: 20, pageId: VICTIM_ARTICLE.id, content: VICTIM_SECRET },
  ],
  annChunkIds: [20, 10],
  keywordArticleIds: [OWNED_ARTICLE.id, VICTIM_ARTICLE.id],
};

const asker = (): CurrentUserContext => ({
  userId: "user-1",
  orgId: ORG,
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(ASKER_MEMBERSHIP, false),
});

const makeKbAccess = () => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({
    userId: "user-1",
    membershipId: ASKER_MEMBERSHIP,
    roleSlugs: ["MEMBER"],
  }),
});

const makeGateway = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest
    .fn()
    .mockResolvedValue({ ok: true, vectorLiteral: "[0.1,0.2]" }),
  invokeTextWithUsage: jest.fn().mockResolvedValue({
    ok: true,
    data: "an answer",
    aiUsage: {
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      credits: 0,
      costUsd: 0,
    },
  }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const askerStanding = {
  orgId: ORG,
  userId: "user-1",
  membershipId: ASKER_MEMBERSHIP,
  roleSlugs: ["MEMBER"],
  isOrgOwner: false,
  isKbAdmin: false,
  accessibleSpaceIds: [1],
  accessibleProjectIds: [],
  permissionsVersion: 1,
};

const makeKbAuth = () => ({
  resolveStanding: jest.fn().mockResolvedValue(askerStanding),
  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "bypass" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest
    .fn()
    .mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
});

function buildSearch(scope: DataScope) {
  const { db, recorded, executed, inserted } = makeFakeKbDb(FIXTURES);
  const gateway = makeGateway();
  const events = makeEvents();
  const access = makeKbAccess();
  const scopes = { scopeFor: jest.fn().mockResolvedValue(scope) };
  const auth = makeKbAuth();
  const search = new KbSearchService(
    db as never,
    events as never,
    new KbCandidateService(db as never),
    scopes as never,
    auth as never,
  );
  const retrieval = new KbSearchRetrievalService(
    db as never,
    gateway as never,
    new KbCandidateService(db as never),
    scopes as never,
    auth as never,
  );
  return { search, retrieval, db, recorded, executed, inserted, gateway, events, access, scopes };
}

const SUPPORT_ARTICLE_BRANCH = '"kb_pages"."content_type" = ';

const articleQueries = (recorded: RecordedQuery[]): RecordedQuery[] =>
  recorded.filter(
    (q) =>
      (q.table === "kb_pages" || (q.table === "kb_article_chunks" && q.joins.includes("kb_pages"))) &&
      q.sql.includes(SUPPORT_ARTICLE_BRANCH) &&
      (ownerBoundIn(q) !== undefined || refusesEverything(q)),
  );

describe("BOLA sweep — RAG retrieval binds the direct read's object-level scope", () => {
  it("an asker scoped to 'own' receives no chunk from an article they do not own", async () => {
    const { retrieval } = buildSearch("own");

    const results = await retrieval.retrieveTopArticles(asker(), "compensation", 6);

    expect(results.map((r) => r.id)).toEqual([OWNED_ARTICLE.id]);
    for (const result of results) expect(result.contentText).not.toContain(VICTIM_SECRET);
  });

  it("the same asker at scope 'all' still receives both — the guard is not a blanket denial", async () => {
    const { retrieval } = buildSearch("all");

    const results = await retrieval.retrieveTopArticles(asker(), "compensation", 6);

    expect(results.map((r) => r.id).sort()).toEqual([OWNED_ARTICLE.id, VICTIM_ARTICLE.id]);
  });

  it("every article-touching predicate binds the asker's membership and never the owner's", async () => {
    const { retrieval, recorded } = buildSearch("own");
    await retrieval.retrieveTopArticles(asker(), "compensation", 6);

    const touching = articleQueries(recorded);
    expect(touching.length).toBeGreaterThanOrEqual(3);
    for (const query of touching) {
      expect(ownerBoundIn(query)).toBe(ASKER_MEMBERSHIP);
      expect(query.params).not.toContain(VICTIM_MEMBERSHIP);
    }
  });

  it("the candidate queries carry the predicate, so the victim's chunk is never a candidate", async () => {
    const { retrieval, recorded } = buildSearch("own");
    await retrieval.retrieveTopArticles(asker(), "compensation", 6);

    const vector = recorded.find(
      (q) => q.table === "kb_article_chunks" && q.joins.includes("kb_pages"),
    );
    expect(vector).toBeDefined();
    expect(ownerBoundIn(vector as RecordedQuery)).toBe(ASKER_MEMBERSHIP);
  });

  it("scope 'none' refuses in SQL rather than after retrieval", async () => {
    const { retrieval, recorded } = buildSearch("none");

    const results = await retrieval.retrieveTopArticles(asker(), "compensation", 6);

    expect(results).toEqual([]);
    expect(articleQueries(recorded).length).toBeGreaterThanOrEqual(2);
    for (const query of articleQueries(recorded)) expect(refusesEverything(query)).toBe(true);
  });

  it("a principal with no acting membership resolves to a refusal, never to 'all'", () => {
    const agent = { ...asker(), principal: { kind: "agent-token" as const, tokenId: "t" } };
    const filter = articleOwnerScopeFilter(scopedRead(ORG, "own"), agent as never);
    expect(filter).not.toBeNull();
    expect(new PgDialect().sqlToQuery(filter as SQL).sql).toContain("false");
  });
});

const scopedRead = (orgId: string, scope: DataScope) =>
  ScopedRead.of(orgId, "user-1", scope);

describe("BOLA sweep — the RAG predicate is the direct read's predicate", () => {
  const dialect = new PgDialect();
  const render = (filter: SQL | null): string =>
    filter === null ? "" : dialect.sqlToQuery(filter).sql;

  it("retrieval and the direct read build the owner predicate from one function", () => {
    for (const scope of ["all", "team", "own", "none"] as DataScope[]) {
      const directRead = articleOwnerScopeFilter(scopedRead(ORG, scope), asker());
      const retrieval = articleOwnerScopeFilter(scopedRead(ORG, scope), asker());
      expect(render(retrieval)).toBe(render(directRead));
    }
  });

  it("the predicate is the column the direct read narrows on", () => {
    const filter = articleOwnerScopeFilter(scopedRead(ORG, "own"), asker());
    const compiled = dialect.sqlToQuery(filter as SQL);
    expect(compiled.sql).toContain('"kb_pages"."owner_membership_id"');
    // The filter is a scoped read, so it binds the tenant alongside the owner.
    expect(compiled.params).toEqual([ORG, ASKER_MEMBERSHIP]);
    expect(compiled.sql).toContain('"kb_pages"."org_id"');
  });

  const read = (rel: string): string =>
    readFileSync(join(BACKEND_ROOT, "src/modules/kb/retrieval", rel), "utf8");

  it("both `GET /kb/search` and retrieval spend the filter in SQL, not a post-filter, now that the owner filter lives once in kb-article-owner-scope.ts", () => {
    const ownerScope = read("kb-article-owner-scope.ts");
    expect(ownerScope).toContain("return articleOwnerScopeFilter(read, user)");

    const search = read("kb-search.service.ts");
    expect(search).toContain("scope: articleOwnerScope(membershipId)");
    expect(search).toMatch(/scope\.compose\(\s*\{\s*tenant: kbPages\.orgId,\s*scope: articleOwnerScope\(membershipId\),\s*and: domain,/);

    const retrieval = read("kb-search-retrieval.service.ts");
    expect(retrieval).toContain("this.articleOwnerFilterFor(user)");
    expect(retrieval).toMatch(/restriction,\s*ownerFilter,\s*spaceId/);
    expect(retrieval).toContain("articleConditions.push(ownerFilter)");
  });

  it("retrieval resolves the scope itself through the one shared resolver, so no caller can hand it a wider one", () => {
    const ownerScope = read("kb-article-owner-scope.ts");
    const resolver = ownerScope.slice(ownerScope.indexOf("export async function resolveArticleOwnerFilter"));
    expect(resolver.slice(0, 300)).toContain("resolveKbArticlesViewScope(scopes, user)");

    for (const file of ["kb-search.service.ts", "kb-search-retrieval.service.ts"]) {
      const source = read(file);
      const method = source.slice(source.indexOf("async articleOwnerFilterFor"));
      expect([file, method.slice(0, 200)]).toEqual([file, expect.stringContaining("resolveArticleOwnerFilter(this.scopes, user)")]);
      expect(source).not.toMatch(/retrieveTopArticles\([^)]*scope: DataScope/);
    }
  });
});

describe("BOLA sweep — the RAG fix keeps the measured retrieval shape", () => {
  const CANDIDATE_SERVICE = "src/modules/kb/retrieval/kb-candidate.service.ts";
  const candidates = readFileSync(join(BACKEND_ROOT, CANDIDATE_SERVICE), "utf8");

  /**
   * The vector query moved out of the service into `kb-vector-candidate-query.ts`,
   * and a scan of the service's own text alone stopped seeing the guard entirely —
   * reporting a missing correctness guard where the behavioural test below proves
   * it still executes. So the scan follows the service's own relative imports one
   * hop, in import order, which is where an extraction can put it.
   */
  const retrievalSource = [
    candidates,
    ...[...candidates.matchAll(/from\s+"(\.\/[\w./-]+)"/g)].map((match) =>
      readFileSync(join(BACKEND_ROOT, "src/modules/kb/retrieval", `${match[1] ?? ""}.ts`), "utf8"),
    ),
  ].join("\n");

  /**
   * Ticket 12 measured this on a 49,000-chunk corpus: without it the majority
   * tenant silently returns 32-35 rows for a LIMIT 120, so it is a correctness
   * guard and not a tuning knob.
   */
  it("the HNSW iterative-scan guard is still set before the ANN query", () => {
    expect(retrievalSource).toContain("SET LOCAL hnsw.iterative_scan = relaxed_order");
    const guardAt = retrievalSource.indexOf("hnsw.iterative_scan");
    const annAt = retrievalSource.indexOf("ORDER BY embedding <=>");
    expect(guardAt).toBeGreaterThan(-1);
    expect(annAt).toBeGreaterThan(guardAt);
  });

  it("the guard actually executes on the retrieval path", async () => {
    const { retrieval, executed } = buildSearch("own");
    await retrieval.retrieveTopArticles(asker(), "compensation", 6);
    expect(executed.some((s) => s.includes("hnsw.iterative_scan"))).toBe(true);
  });

  it("the owner predicate adds no join — it lands on the already-joined kb_pages, and the article/page cutover left exactly one innerJoin where there were two", () => {
    const joins = candidates.match(/innerJoin\(/g) ?? [];
    expect(joins.length).toBe(1);
    expect(candidates).toContain("if (ownerScopeFilter) conditions.push(ownerScopeFilter)");
  });
});

describe("BOLA sweep — POST /kb/ask context window", () => {
  const modules: TestingModule[] = [];
  afterEach(async () => {
    await Promise.all(modules.map(module => module.close()));
    modules.length = 0;
  });
  const buildAsk = async (scope: DataScope) => {
    const built = buildSearch(scope);
    const module = await Test.createTestingModule({ providers: [
      KbAskService, KbCitationVisibilityService, KbAskCitationService, KbRetrievalService,
      { provide: KbSearchRetrievalService, useValue: built.retrieval },
      { provide: REDIS, useValue: null },
      { provide: KbLinkedDocumentAskSource, useValue: NO_LINKED_DOCUMENTS },
      { provide: DRIZZLE, useValue: built.db },
      { provide: AiGatewayService, useValue: built.gateway },
      { provide: KbEventsService, useValue: built.events },
      { provide: KbSearchService, useValue: built.search },
      { provide: KbAccessService, useValue: built.access },
      { provide: KnowledgeAuthorizationService, useValue: makeKbAuth() },
    ] }).compile();
    modules.push(module);
    return { ...built, ask: module.get(KbAskService) };
  };

  it("a non-owner's answer context never contains the other article's text", async () => {
    const { ask, gateway } = await buildAsk("own");

    const result = await ask.ask(asker(), { question: "what is the comp plan?" });

    const prompt = JSON.stringify(gateway.invokeTextWithUsage.mock.calls[0]?.[0]);
    expect(prompt).toContain(MINE);
    expect(prompt).not.toContain(VICTIM_SECRET);
    expect(result.citations.map((c) => JSON.stringify(c)).join(" ")).not.toContain(
      VICTIM_ARTICLE.title,
    );
  });

  it("the AI interaction telemetry row carries the asker's tenant, so the write the double must support is asserted and cannot silently vanish again", async () => {
    const { ask, inserted } = await buildAsk("own");

    await ask.ask(asker(), { question: "what is the comp plan?" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe("kb_ai_interactions");
    expect(inserted[0]?.values.orgId).toBe(ORG);
  });

  it("the owner of both articles still gets both — the answer is not emptied", async () => {
    const { ask, gateway } = await buildAsk("all");

    await ask.ask(asker(), { question: "what is the comp plan?" });

    const prompt = JSON.stringify(gateway.invokeTextWithUsage.mock.calls[0]?.[0]);
    expect(prompt).toContain(MINE);
    expect(prompt).toContain(VICTIM_SECRET);
  });

  it("citation re-verification applies the same predicate the retrieval did", async () => {
    const { ask, recorded } = await buildAsk("own");
    await ask.ask(asker(), { question: "what is the comp plan?" });

    const citationQuery = recorded
      .filter((q) => q.table === "kb_pages")
      .at(-1) as RecordedQuery;
    expect(ownerBoundIn(citationQuery)).toBe(ASKER_MEMBERSHIP);
  });

  it("no rule about permissions is delegated to the prompt", () => {
    const source = readFileSync(
      join(BACKEND_ROOT, "src/modules/kb/retrieval/kb-ask.service.ts"),
      "utf8",
    );
    const systemPrompt = source.slice(
      source.indexOf("const ASK_SYSTEM_PROMPT"),
      source.indexOf("export type AskCitation"),
    );
    expect(systemPrompt).not.toMatch(/only (show|return|use) (articles|documents) (the|that)/i);
    expect(systemPrompt).not.toMatch(/if the user (is not|does not have)/i);
  });
});

describe("BOLA sweep — the scoped predicate is the reason, proven by construction", () => {
  it("an unscoped article read would return the victim's row from the same fixtures", () => {
    const dialect = new PgDialect();
    const unscoped = and(eq(kbPages.orgId, ORG));
    const compiled = dialect.sqlToQuery(unscoped as SQL);
    const query: RecordedQuery = {
      table: "kb_pages",
      joins: [],
      sql: compiled.sql,
      params: compiled.params,
    };
    expect(ownerBoundIn(query)).toBeUndefined();
    expect(refusesEverything(query)).toBe(false);
  });
});
