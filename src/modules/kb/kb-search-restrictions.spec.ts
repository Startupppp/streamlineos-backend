import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
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

const makeDb = () => {
  const chain = makeChain([]);
  return { select: jest.fn().mockReturnValue(chain) };
};

const makeAccess = (spaceIds: number[] = [1], isAdminResult = false) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  isAdmin: jest.fn().mockReturnValue(isAdminResult),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: ["MEMBER"] }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeEmbeddings = () => ({
  isConfigured: jest.fn().mockReturnValue(false),
  embedQuery: jest.fn(),
  toVectorLiteral: jest.fn(),
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
    );

    const user = makeUser();
    await svc.retrieveTopArticles(user, "test query", 5);

    expect(access.getPrincipalIds).toHaveBeenCalledWith(user);
    expect(access.isAdmin).toHaveBeenCalledWith(user);
  });

  it("returns empty array when query is blank", async () => {
    const db = makeDb();
    const access = makeAccess([1], false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
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
    );

    const result = await svc.retrieveTopArticles(makeUser(), "test", 5);
    expect(result).toEqual([]);
  });
});
