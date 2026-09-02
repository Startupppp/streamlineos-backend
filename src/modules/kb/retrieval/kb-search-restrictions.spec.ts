import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
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

const makeAccess = (spaceIds: number[] = [1], isAdminResult = false) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockReturnValue(isAdminResult),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: ["MEMBER"] }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  embedQueryWithCredit: jest.fn(),
});

describe("KbSearchService — restriction enforcement", () => {
  it("resolves principal once per retrieveTopArticles call", async () => {
    const db = makeDb();
    const access = makeAccess([1], false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const user = makeUser();
    await svc.retrieveTopArticles(user, "test query", 5);

    expect(access.getPrincipalIds).toHaveBeenCalledWith(user);
    expect(access.isAdmin).toHaveBeenCalledWith(user);
  });

  it("asks the SECURITY DEFINER search function for ids before falling back to a scan", async () => {
    const db = makeDb([{ id: 7 }, { id: 9 }]);
    const access = makeAccess([1], false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "test query", 5);

    expect(db.execute).toHaveBeenCalled();
    const statement = db.execute.mock.calls[0]?.[0];
    expect(JSON.stringify(statement)).toContain("app.search_kb_article_ids");
  });

  it("returns empty array when query is blank", async () => {
    const db = makeDb();
    const access = makeAccess([1], false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const result = await svc.retrieveTopArticles(makeUser(), "  ", 5);
    expect(result).toEqual([]);
    expect(access.getPrincipalIds).not.toHaveBeenCalled();
  });

  it("skips article queries when space list is empty but still queries pages", async () => {
    const db = makeDb();
    const access = makeAccess([], false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const result = await svc.retrieveTopArticles(makeUser(), "test", 5);
    expect(result).toEqual([]);
  });
});
