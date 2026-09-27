jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (
    _db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => fn(_db),
}));

import { KbRetrievalService } from "./kb-retrieval.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { kbDocumentKey } from "./kb-ask-context";

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

const PASSAGE = {
  documentKey: kbDocumentKey("article", 1),
  documentTitle: "Reset password",
  passageIndex: 0,
  text: "Passage about resetting a password.",
};

function makeDb() {
  return {
    execute: jest.fn().mockResolvedValue([{ one: 1, chunk_count: 0 }]),
  };
}

function makeSearch(overrides: Record<string, unknown> = {}) {
  return {
    resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: VECTOR }),
    retrieveTopArticles: jest.fn().mockResolvedValue([ARTICLE]),
    retrieveTopArticlesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [ARTICLE] }),
    retrieveTopSources: jest.fn().mockResolvedValue([]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    retrieveTopSourcesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [] }),
    retrieveDocumentPassagesWithOutcome: jest
      .fn()
      .mockResolvedValue({ kind: "ok", results: [PASSAGE] }),
    ...overrides,
  };
}

function retrieveWith(search: Record<string, unknown>) {
  const service = new KbRetrievalService(makeDb() as never, search as never, null);
  return service.retrieve(makeUser(), QUESTION);
}

describe("the retrieval facade separates a channel that failed from one that found nothing", () => {
  it("reports passages degraded when the passage channel FAILED, because a successful embedding must not let a thrown query read as an authorized empty corpus", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveDocumentPassagesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "failed", results: [] }),
      }),
    );

    expect(result.passages).toEqual([]);
    expect(result.degraded.passages).toBe(true);
  });

  it("reports sources degraded when the source channel FAILED", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveTopSourcesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "failed", results: [] }),
      }),
    );

    expect(result.degraded.sources).toBe(true);
  });

  it("CONTROL: reports passages NOT degraded when the channel genuinely returned nothing, so the failure assertions read the outcome kind rather than merely an empty array", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveDocumentPassagesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "empty", results: [] }),
      }),
    );

    expect(result.passages).toEqual([]);
    expect(result.degraded.passages).toBe(false);
  });

  it("CONTROL: reports sources NOT degraded when the source channel genuinely returned nothing", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveTopSourcesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "empty", results: [] }),
      }),
    );

    expect(result.degraded.sources).toBe(false);
  });

  it("still reports degraded when the channel returned rows but marked itself degraded, so the outcome kind did not replace the per-row signal", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveDocumentPassagesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "degraded", results: [PASSAGE] }),
      }),
    );

    expect(result.passages).toHaveLength(1);
    expect(result.degraded.passages).toBe(true);
  });

  it("consumes the outcome-returning passage method, because the unwrapping one discards the kind that separates failed from empty", async () => {
    const search = makeSearch();

    await retrieveWith(search);

    expect(search.retrieveDocumentPassagesWithOutcome).toHaveBeenCalled();
    expect(search.retrieveDocumentPassages).not.toHaveBeenCalled();
  });

  it("consumes the outcome-returning source method", async () => {
    const search = makeSearch();

    await retrieveWith(search);

    expect(search.retrieveTopSourcesWithOutcome).toHaveBeenCalled();
    expect(search.retrieveTopSources).not.toHaveBeenCalled();
  });

  it("reports documents degraded when the documents channel FAILED, because a thrown article query must not read as an authorized empty corpus", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveTopArticlesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "failed", results: [] }),
      }),
    );

    expect(result.documents).toEqual([]);
    expect(result.degraded.documents).toBe(true);
  });

  it("CONTROL: reports documents NOT degraded when the documents channel genuinely returned nothing, so the failure assertion reads the outcome kind rather than merely an empty array", async () => {
    const result = await retrieveWith(
      makeSearch({
        retrieveTopArticlesWithOutcome: jest
          .fn()
          .mockResolvedValue({ kind: "empty", results: [] }),
      }),
    );

    expect(result.documents).toEqual([]);
    expect(result.degraded.documents).toBe(false);
  });

  it("consumes the outcome-returning articles method, because the unwrapping one discards the kind that separates failed from empty", async () => {
    const search = makeSearch();

    await retrieveWith(search);

    expect(search.retrieveTopArticlesWithOutcome).toHaveBeenCalled();
    expect(search.retrieveTopArticles).not.toHaveBeenCalled();
  });
});
