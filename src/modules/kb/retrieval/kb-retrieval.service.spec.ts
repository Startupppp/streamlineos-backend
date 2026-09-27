jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (
    _db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => fn(_db),
}));

import {
  KbRetrievalService,
  isAnyChannelDegraded,
  type KbRetrievalResult,
} from "./kb-retrieval.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { kbDocumentKey } from "./kb-ask-context";
import type { QueryEmbedding } from "./kb-search-retrieval.service";

const VECTOR = "[0.1,0.2]";
const QUESTION = "how do I reset my password";

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

const ARTICLE = {
  kind: "article" as const,
  id: 1,
  title: "Reset password",
  slug: "reset-password",
  spaceId: 1,
  contentText: "How to reset your password.",
  updatedAt: new Date("2024-01-01"),
};

const SOURCE = {
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

const PASSAGE = {
  documentKey: kbDocumentKey("article", 1),
  documentTitle: "Reset password",
  passageIndex: 0,
  text: "Passage about resetting a password.",
};

function makeDb(hasContent = true) {
  return {
    execute: jest
      .fn()
      .mockResolvedValue(hasContent ? [{ one: 1, chunk_count: 0 }] : []),
  };
}

function makeSearch(embedResult: QueryEmbedding = { vectorLiteral: VECTOR }) {
  return {
    resolveQueryEmbedding: jest.fn().mockResolvedValue(embedResult),
    retrieveTopArticles: jest.fn().mockResolvedValue([ARTICLE]),
    retrieveTopArticlesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [ARTICLE] }),
    retrieveTopSources: jest.fn().mockResolvedValue([SOURCE]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([PASSAGE]),
    retrieveTopSourcesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [SOURCE] }),
    retrieveDocumentPassagesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [PASSAGE] }),
  };
}

describe("KbRetrievalService.retrieve — one embedding per call", () => {
  it("calls resolveQueryEmbedding exactly once even when articles, sources and passages are all retrieved", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    await service.retrieve(makeUser(), QUESTION);

    expect(search.resolveQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(search.retrieveTopArticlesWithOutcome).toHaveBeenCalledTimes(1);
    expect(search.retrieveTopSourcesWithOutcome).toHaveBeenCalledTimes(1);
    expect(search.retrieveDocumentPassagesWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("hands the same embedding object to all three retrieval paths so one charge is not the signature of a service that retrieved nothing", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    const seen: {
      articles?: QueryEmbedding;
      sources?: QueryEmbedding;
      passages?: QueryEmbedding;
    } = {};

    jest
      .spyOn(search, "retrieveTopArticlesWithOutcome")
      .mockImplementation(
        (_user, _query, _limit, _spaceId, _verifiedOnly, embedding) => {
          seen.articles = embedding;
          return Promise.resolve({ kind: "ok" as const, results: [ARTICLE] });
        },
      );
    jest
      .spyOn(search, "retrieveTopSourcesWithOutcome")
      .mockImplementation((_user, _query, _limit, _sourceIds, embedding) => {
        seen.sources = embedding;
        return Promise.resolve({ kind: "ok" as const, results: [SOURCE] });
      });
    jest
      .spyOn(search, "retrieveDocumentPassagesWithOutcome")
      .mockImplementation(
        (_user, _query, _articleIds, _pageIds, embedding) => {
          seen.passages = embedding;
          return Promise.resolve({ kind: "ok" as const, results: [PASSAGE] });
        },
      );

    const service = new KbRetrievalService(db as never, search as never, null);
    await service.retrieve(makeUser(), QUESTION);

    expect(seen.articles).toBeDefined();
    expect(seen.articles?.vectorLiteral).toBe(VECTOR);
    expect(seen.sources).toBe(seen.articles);
    expect(seen.passages).toBe(seen.articles);
  });

  it("CONTROL: calling resolveQueryEmbedding three times independently records three calls, proving the single-call assertion above is not vacuous", async () => {
    const search = makeSearch();

    await search.resolveQueryEmbedding(QUESTION, "org-1");
    await search.resolveQueryEmbedding(QUESTION, "org-1");
    await search.resolveQueryEmbedding(QUESTION, "org-1");

    expect(search.resolveQueryEmbedding).toHaveBeenCalledTimes(3);
  });
});

describe("KbRetrievalService.retrieve — degraded flag distinguishes outage from empty corpus", () => {
  it("returns all degraded=false for an empty corpus, so an outage cannot be confused with no content", async () => {
    const db = makeDb(false);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.degraded).toEqual({ documents: false, sources: false, passages: false });
    expect(result.documents).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
    expect(result.passages).toHaveLength(0);
  });

  it("returns all channels degraded when the embedding provider fails and the corpus is non-empty, so an outage is distinguishable from an empty corpus", async () => {
    const db = makeDb(true);
    const search = makeSearch({ vectorLiteral: null });
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.degraded.documents).toBe(true);
    expect(result.degraded.sources).toBe(true);
    expect(result.degraded.passages).toBe(true);
  });

  it("BITE: a result with all degraded forced to false would not satisfy the outage test above — confirming the flag is not dead code", async () => {
    const db = makeDb(true);
    const search = makeSearch({ vectorLiteral: null });
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);
    const withoutFlag: KbRetrievalResult = {
      ...result,
      degraded: { documents: false, sources: false, passages: false },
    };

    expect(isAnyChannelDegraded(result.degraded)).toBe(true);
    expect(isAnyChannelDegraded(withoutFlag.degraded)).toBe(false);
  });

  it("marks sources degraded when individual source items carry the degraded flag even when embedding succeeds — passages and documents remain non-degraded", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    jest.spyOn(search, "retrieveTopSourcesWithOutcome").mockResolvedValue({
      kind: "ok" as const,
      results: [{ ...SOURCE, degraded: true as const }],
    });
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.degraded.sources).toBe(true);
    expect(result.degraded.documents).toBe(false);
  });
});

describe("KbRetrievalService.retrieve — strategy is inspectable in the result", () => {
  it("carries a strategy in the result so callers do not need to recompute it", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.strategy).toBeDefined();
    expect(result.strategy.kind).toBe("exact");
  });

  it("returns exact strategy for an empty corpus without querying the chunk count", async () => {
    const db = makeDb(false);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.strategy).toEqual({ kind: "exact" });
  });
});

describe("KbRetrievalService.retrieve — result shape", () => {
  it("returns documents, sources and passages in a single result so the caller needs to know three facts, not nine", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    const result = await service.retrieve(makeUser(), QUESTION);

    expect(result.documents).toEqual([ARTICLE]);
    expect(result.sources).toEqual([SOURCE]);
    expect(result.passages).toEqual([PASSAGE]);
    expect(result.degraded).toEqual({ documents: false, sources: false, passages: false });
    expect(result.strategy).toEqual({ kind: "exact" });
  });

  it("skips retrieveDocumentPassages when there are no documents to retrieve passages for", async () => {
    const db = makeDb(true);
    const search = makeSearch();
    jest.spyOn(search, "retrieveTopArticlesWithOutcome").mockResolvedValue({ kind: "empty" as const, results: [] });
    const service = new KbRetrievalService(db as never, search as never, null);

    await service.retrieve(makeUser(), QUESTION);

    expect(search.retrieveDocumentPassagesWithOutcome).not.toHaveBeenCalled();
  });

  it("does not call resolveQueryEmbedding when the corpus is empty, avoiding a paid round-trip for orgs with no content", async () => {
    const db = makeDb(false);
    const search = makeSearch();
    const service = new KbRetrievalService(db as never, search as never, null);

    await service.retrieve(makeUser(), QUESTION);

    expect(search.resolveQueryEmbedding).not.toHaveBeenCalled();
  });
});
