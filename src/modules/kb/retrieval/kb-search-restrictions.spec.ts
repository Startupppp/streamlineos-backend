import { sql } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

const makeChain = (finalValue: unknown[] = []) => {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  chain.limit = jest.fn().mockResolvedValue(finalValue);
  chain.offset = jest.fn().mockResolvedValue(finalValue);
  return chain;
};

const makeDb = (searchIds: unknown[] = []) => {
  const chain = makeChain([]);
  return {
    select: jest.fn().mockReturnValue(chain),
    execute: jest.fn().mockResolvedValue(searchIds),
  };
};

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeAuth = (spaceIds: number[] = [1]) => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: spaceIds,
    accessibleProjectIds: [],
    permissionsVersion: 1,
  }),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
});

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  embedQueryWithCredit: jest.fn(),
});

describe("KbSearchService — restriction enforcement", () => {
  it("resolves standing once per retrieveTopArticles call so the authorization seam is not queried per row", async () => {
    const db = makeDb();
    const auth = makeAuth([1]);

    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      auth as never,
    );

    const user = makeUser();
    await svc.retrieveTopArticles(user, "test query", 5);

    expect(auth.resolveStanding).toHaveBeenCalledWith(user);
    expect(auth.resolveStanding).toHaveBeenCalledTimes(1);
  });

  it("asks the canonical authorization seam for the caller's standing to build the page visibility predicate", async () => {
    const db = makeDb();
    const auth = makeAuth([1]);

    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      auth as never,
    );

    const user = makeUser();
    await svc.retrieveTopArticles(user, "test query", 5);

    expect(auth.resolveStanding).toHaveBeenCalledWith(user);
  });

  it("asks the SECURITY DEFINER search function for ids before falling back to a scan", async () => {
    const db = makeDb([{ id: 7 }, { id: 9 }]);

    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeAuth() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "test query", 5);

    expect(db.execute).toHaveBeenCalled();
    const statement = db.execute.mock.calls[0]?.[0];
    expect(JSON.stringify(statement)).toContain("app.search_kb_page_ids");
  });

  it("returns empty array when query is blank", async () => {
    const db = makeDb();
    const auth = makeAuth([1]);

    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      auth as never,
    );

    const result = await svc.retrieveTopArticles(makeUser(), "  ", 5);
    expect(result).toEqual([]);
  });

  it("skips article queries when space list is empty but still queries pages", async () => {
    const db = makeDb();

    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeAuth([]) as never,
    );

    const result = await svc.retrieveTopArticles(makeUser(), "test", 5);
    expect(result).toEqual([]);
  });
});
