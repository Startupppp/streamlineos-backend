const mockTxnDepth = { value: 0 };

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (
    db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    mockTxnDepth.value += 1;
    try {
      return await fn(db);
    } finally {
      mockTxnDepth.value -= 1;
    }
  },
}));

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { KbSearchRetrievalService, type QueryEmbedding } from "./kb-search-retrieval.service";
import { KbRetrievalService } from "./kb-retrieval.service";
import { kbDocumentKey } from "./kb-ask-context";

const VECTOR = "[0.1,0.2]";
const QUESTION = "how do I reset my password";
const dialect = new PgDialect();

type Node = Promise<unknown[]> & Record<string, jest.Mock>;

const STRICT_FENCE =
  /"kb_article_chunks"\."acl_revision" = "kb_pages"\."acl_revision"/;

const NULL_ESCAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["IS NOT DISTINCT FROM", /IS NOT DISTINCT FROM/i],
  ["IS NULL", /\bis null\b/i],
  ["COALESCE", /coalesce/i],
  ["an inequality", />=|<=|<>|!=/i],
];

function expectStrictFence(rendered: string): void {
  if (!STRICT_FENCE.test(rendered))
    throw new Error(`acl_revision fence missing — no plain equality in: ${rendered}`);
  for (const [name, escape] of NULL_ESCAPES)
    if (escape.test(rendered))
      throw new Error(`acl_revision fence escaped by ${name} in: ${rendered}`);
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

interface DbCapture {
  joins: SQL[];
  orderBys: SQL[][];
}

function makeDb(rows: unknown[], executeRows: unknown[] = [{ one: 1 }]) {
  const capture: DbCapture = { joins: [], orderBys: [] };
  const node = (): Node => {
    const pending = Promise.resolve(rows) as Node;
    pending.from = jest.fn(() => node());
    pending.innerJoin = jest.fn((_table: unknown, condition: SQL) => {
      capture.joins.push(condition);
      return node();
    });
    pending.leftJoin = jest.fn(() => {
      throw new Error("a prompt-text join must stay an inner join");
    });
    pending.where = jest.fn(() => node());
    pending.orderBy = jest.fn((...order: SQL[]) => {
      capture.orderBys.push(order);
      return node();
    });
    pending.limit = jest.fn(() => node());
    pending.offset = jest.fn(() => node());
    return pending;
  };
  const db = {
    select: jest.fn(() => node()),
    execute: jest.fn(() => Promise.resolve(executeRows)),
    insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve([])) })),
  };
  return { db, capture };
}

const makeAccess = (spaceIds: number[] = [1]) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  getAccessibleSpaceIdsWithCacheOutcome: jest
    .fn()
    .mockResolvedValue({ spaceIds, cacheOutcome: "hit" }),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest
    .fn()
    .mockResolvedValue({ userId: "user-1", membershipId: 1, roleSlugs: [] }),
});

const makeAuth = (spaceIds: number[] = [1]) => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
  assertPageAccess: jest
    .fn()
    .mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  resolveStanding: jest.fn().mockResolvedValue({
    accessibleSpaceIds: spaceIds,
    accessibleProjectIds: [],
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    permissionsVersion: 1,
  }),
  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds, cacheOutcome: "hit" }),
});

const makeScopes = (scope = "all") => ({
  scopeFor: jest.fn().mockResolvedValue(scope),
});

const makeEvents = () => ({
  record: jest.fn().mockResolvedValue(undefined),
  recordDetached: jest.fn().mockResolvedValue(undefined),
});

function makeEmbeddings(depths?: number[]) {
  return {
    isEmbeddingConfigured: jest.fn(() => true),
    embedQueryWithCredit: jest.fn(() => {
      depths?.push(mockTxnDepth.value);
      return Promise.resolve({ ok: true, vector: [0.1, 0.2], vectorLiteral: VECTOR });
    }),
  };
}

function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
}

function makeSearchRetrieval(
  db: unknown,
  embeddings: unknown,
  candidates: KbCandidateService,
  cache: unknown = null,
): KbSearchRetrievalService {
  return new KbSearchRetrievalService(
    db as never,
    embeddings as never,
    candidates,
    makeScopes() as never,
    makeAuth() as never,
    cache as never,
  );
}

function makeSearchSvc(
  db: unknown,
  candidates: KbCandidateService,
): KbSearchService {
  return new KbSearchService(
    db as never,
    makeEvents() as never,
    candidates,
    makeScopes() as never,
    makeAuth() as never,
  );
}

const ARTICLE = {
  kind: "article" as const,
  id: 1,
  title: "Reset your password",
  slug: "reset-your-password",
  spaceId: 1,
  contentText: "Open settings and choose reset.",
  updatedAt: new Date("2024-01-01"),
};

const SOURCE_DOCUMENT = {
  sourceId: 5,
  title: "Employee handbook",
  spaceId: null,
  updatedAt: new Date("2024-01-02"),
  passages: [
    {
      documentKey: kbDocumentKey("source", 5),
      documentTitle: "Employee handbook",
      passageIndex: 0,
      text: "Handbook passage about passwords.",
    },
  ],
};

const DOCUMENT_PASSAGE = {
  documentKey: kbDocumentKey("article", 1),
  documentTitle: "Reset your password",
  passageIndex: 0,
  text: "Passage about resetting a password.",
};

async function runAsk() {
  const depths: number[] = [];
  const embeddings = makeEmbeddings(depths);
  const { db } = makeDb([{ id: 1 }]);
  const searchRetrieval = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never));

  const seen: {
    top?: QueryEmbedding;
    sources?: QueryEmbedding;
    passages?: QueryEmbedding;
  } = {};

  jest
    .spyOn(searchRetrieval, "retrieveTopArticlesWithOutcome")
    .mockImplementation((_user, _query, _limit, _spaceId, _verifiedOnly, embedding) => {
      seen.top = embedding;
      return Promise.resolve({ kind: "ok" as const, results: [ARTICLE] });
    });
  jest
    .spyOn(searchRetrieval, "retrieveTopSourcesWithOutcome")
    .mockImplementation((_user, _query, _limit, _sourceIds, embedding) => {
      seen.sources = embedding;
      return Promise.resolve({ kind: "ok" as const, results: [SOURCE_DOCUMENT] });
    });
  jest
    .spyOn(searchRetrieval, "retrieveDocumentPassagesWithOutcome")
    .mockImplementation((_user, _query, _articleIds, _pageIds, embedding) => {
      seen.passages = embedding;
      return Promise.resolve({ kind: "ok" as const, results: [DOCUMENT_PASSAGE] });
    });

  const retrieval = new KbRetrievalService(db as never, searchRetrieval, null);
  const result = await retrieval.retrieve(makeUser(), QUESTION);
  return { result, embeddings, depths, seen };
}

describe("KB ask hot path — one question buys one embedding, outside the transaction", () => {
  beforeEach(() => {
    mockTxnDepth.value = 0;
  });

  it("charges exactly one query embedding for an ask that retrieves articles, sources and passages", async () => {
    const { result, embeddings } = await runAsk();

    expect(embeddings.embedQueryWithCredit).toHaveBeenCalledTimes(1);
    expect(result.documents).toEqual([ARTICLE]);
  });

  it("hands the same vector to all three retrieval paths, so one charge is not the signature of a service that retrieved nothing", async () => {
    const { seen } = await runAsk();

    expect(seen.top).toBeDefined();
    expect(seen.sources).toBe(seen.top);
    expect(seen.passages).toBe(seen.top);
    expect(seen.top?.vectorLiteral).toBe(VECTOR);
  });

  it("calls the embedding provider with no tenant transaction open, so a provider brown-out parks no pooled connection", async () => {
    const { depths } = await runAsk();

    expect(depths).toEqual([0]);
  });
});

describe("KB retrieval reuses a precomputed vector instead of embedding again", () => {
  it("retrieveTopArticles passes the handed vector to both vector candidate queries and does not re-embed", async () => {
    const { db } = makeDb([{ id: 1 }]);
    const candidates = new KbCandidateService(db as never);
    const articleVector = jest
      .spyOn(candidates, "articleVectorCandidates")
      .mockResolvedValue([]);
    const pageVector = jest
      .spyOn(candidates, "pageVectorCandidates")
      .mockResolvedValue([]);
    jest.spyOn(candidates, "articleKeywordCandidates").mockResolvedValue([]);
    jest.spyOn(candidates, "pageKeywordCandidates").mockResolvedValue([]);
    const embeddings = makeEmbeddings();
    const svc = makeSearchRetrieval(db, embeddings, candidates);

    await svc.retrieveTopArticles(makeUser(), QUESTION, 4, undefined, undefined, {
      vectorLiteral: VECTOR,
    });

    expect(embeddings.embedQueryWithCredit).not.toHaveBeenCalled();
    expect(articleVector.mock.calls[0]).toContain(VECTOR);
    expect(pageVector.mock.calls[0]).toContain(VECTOR);
  });

  it("retrieveTopSources asks for chunk ids with the handed vector and does not re-embed", async () => {
    const { db } = makeDb([
      {
        sourceId: 5,
        title: "Employee handbook",
        spaceId: null,
        updatedAt: new Date("2024-01-02"),
        content: "Handbook passage.",
        chunkIndex: 0,
      },
    ]);
    const candidates = new KbCandidateService(db as never);
    const vectorChunkIds = jest
      .spyOn(candidates, "vectorChunkIds")
      .mockResolvedValue([7]);
    const embeddings = makeEmbeddings();
    const svc = makeSearchRetrieval(db, embeddings, candidates);

    await svc.retrieveTopSources(makeUser(), QUESTION, 4, undefined, {
      vectorLiteral: VECTOR,
    });

    expect(embeddings.embedQueryWithCredit).not.toHaveBeenCalled();
    expect(vectorChunkIds.mock.calls[0]).toContain(VECTOR);
  });

  it("retrieveDocumentPassages orders by the handed vector and does not re-embed", async () => {
    const { db, capture } = makeDb([{ id: 1 }]);
    const embeddings = makeEmbeddings();
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never));

    await svc.retrieveDocumentPassages(makeUser(), QUESTION, [1], [], {
      vectorLiteral: VECTOR,
    });

    expect(embeddings.embedQueryWithCredit).not.toHaveBeenCalled();
    const ordering = capture.orderBys.at(-1) ?? [];
    const params = ordering.flatMap((clause) => dialect.sqlToQuery(clause).params);
    expect(params).toContain(VECTOR);
  });

  it("a null vector from a failed embedding still orders lexically, so the degraded path is unchanged", async () => {
    const { db, capture } = makeDb([{ id: 1 }]);
    const embeddings = makeEmbeddings();
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never));

    await svc.retrieveDocumentPassages(makeUser(), QUESTION, [1], [], {
      vectorLiteral: null,
    });

    const ordering = capture.orderBys.at(-1) ?? [];
    const text = ordering.map((clause) => dialect.sqlToQuery(clause).sql).join(" ");
    expect(text).toContain("ts_rank");
    expect(text).not.toContain("<=>");
  });
});

describe("KB prompt-text join carries the ACL revision fence", () => {
  it("retrieveDocumentPassages joins chunks to pages on a plain acl_revision equality, so a stale chunk cannot reach the prompt", async () => {
    const { db, capture } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, makeEmbeddings(), new KbCandidateService(db as never));

    await svc.retrieveDocumentPassages(makeUser(), QUESTION, [1], [], {
      vectorLiteral: VECTOR,
    });

    expect(capture.joins.length).toBeGreaterThanOrEqual(1);
    const rendered = capture.joins.map((join) => dialect.sqlToQuery(join).sql);
    for (const text of rendered) expectStrictFence(text);
  });

  it("BITE: the fence assertion rejects the join this change replaced, so reverting the fix fails the test above", () => {
    const beforeTheFix =
      '("kb_pages"."id" = "kb_article_chunks"."page_id" and "kb_pages"."org_id" = "kb_article_chunks"."org_id")';

    expect(() => {
      expectStrictFence(beforeTheFix);
    }).toThrow(/fence missing/);
  });
});

describe("KB query embedding cache — a vector is a pure function of tenant, model and text", () => {
  it("embeds a repeated question once for the same tenant even when spacing and case differ, so normalisation and not exact spelling decides the hit", async () => {
    const cache = makeCache();
    const embeddings = makeEmbeddings();
    const { db } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never), cache);

    const first = await svc.resolveQueryEmbedding("How do I reset my password", "org-1");
    const second = await svc.resolveQueryEmbedding(
      "  how   do I RESET my password ",
      "org-1",
    );

    expect(embeddings.embedQueryWithCredit).toHaveBeenCalledTimes(1);
    expect(second.vectorLiteral).toBe(first.vectorLiteral);
  });

  it("embeds the same normalised question again for a second tenant, because sharing the entry would spend one org's credits on another's search and skip the credit reservation entirely (BE-123)", async () => {
    const cache = makeCache();
    const embeddings = makeEmbeddings();
    const { db } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never), cache);

    await svc.resolveQueryEmbedding("How do I reset my password", "org-1");
    await svc.resolveQueryEmbedding("How do I reset my password", "org-2");

    expect(embeddings.embedQueryWithCredit).toHaveBeenCalledTimes(2);
  });

  it("CONTROL: with no cache the same question is embedded twice, so the single call above is the cache and not an inert assertion", async () => {
    const embeddings = makeEmbeddings();
    const { db } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never));

    await svc.resolveQueryEmbedding("How do I reset my password", "org-1");
    await svc.resolveQueryEmbedding("How do I reset my password", "org-1");

    expect(embeddings.embedQueryWithCredit).toHaveBeenCalledTimes(2);
  });

  it("keys the entry by tenant, embedding model and a sha256 of the normalised text, because a key without the tenant lets one org's paid embedding serve every other org and skips the credit reservation on the hit (BE-123)", async () => {
    const cache = makeCache();
    const embeddings = makeEmbeddings();
    const { db } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never), cache);

    await svc.resolveQueryEmbedding(QUESTION, "org-1");

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^kb:qembed:org-1:text-embedding-3-small:[0-9a-f]{64}$/),
      VECTOR,
      CACHE_TTL.WEEK,
    );
    expect(cache.set.mock.calls[0]?.[0]).toContain("org-1");
  });

  it("caches no entry when the provider fails, so an outage is not remembered for an hour", async () => {
    const cache = makeCache();
    const embeddings = {
      isEmbeddingConfigured: jest.fn(() => true),
      embedQueryWithCredit: jest
        .fn()
        .mockResolvedValue({ ok: false, kind: "provider_unavailable" }),
    };
    const { db } = makeDb([{ id: 1 }]);
    const svc = makeSearchRetrieval(db, embeddings, new KbCandidateService(db as never), cache);

    const resolved = await svc.resolveQueryEmbedding(QUESTION, "org-1");

    expect(resolved.vectorLiteral).toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe("GET /kb/search", () => {
  it("ranks lexically and calls no embedding provider, so its request transaction spans no provider round trip", async () => {
    const { db } = makeDb([], []);
    const candidates = new KbCandidateService(db as never);
    const vectorSpy = jest.spyOn(candidates, "articleVectorCandidates").mockResolvedValue([]);
    const svc = makeSearchSvc(db, candidates);
    const scope = {
      denied: false,
      compose: (_spec: unknown, onScoped: (token: { sql: SQL }) => SQL) =>
        onScoped({ sql: sql`true` }),
    };

    const result = await svc.search(
      makeUser(),
      { q: "reset password", pageSize: 20 },
      scope as never,
    );

    expect(vectorSpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });
});
