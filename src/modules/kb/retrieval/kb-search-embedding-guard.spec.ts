import { sql } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-a",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
  } as CurrentUserContext;
}

function makeDb(chunkRows: Array<{ id: number }>) {
  const settled = (): Promise<never[]> & Record<string, jest.Mock> => {
    const pending = Promise.resolve([] as never[]) as Promise<never[]> &
      Record<string, jest.Mock>;
    pending.orderBy = jest.fn(() => pending);
    pending.limit = jest.fn().mockResolvedValue(chunkRows);
    return pending;
  };
  const chain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn(settled),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(chunkRows),
  };
  return { select: jest.fn().mockReturnValue(chain), execute: jest.fn().mockResolvedValue([]) };
}

const makeAccess = () => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-a",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [1],
    accessibleProjectIds: [],
    permissionsVersion: 1,
  }),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
});

function makeEmbeddings() {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
  };
}

describe("KB embedding guard — an unseeded knowledge base costs nothing", () => {
  it("does not embed the question when the org has no indexed chunks", async () => {
    const embeddings = makeEmbeddings();
    const db = makeDb([]);
    const svc = new KbSearchService(
      db as never,
      embeddings as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeAuth() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "how do I reset my password", 6);

    expect(embeddings.embedQueryWithCredit).not.toHaveBeenCalled();
  });

  it("returns nothing from retrieveTopSources without embedding when there are no chunks", async () => {
    const embeddings = makeEmbeddings();
    const db = makeDb([]);
    const svc = new KbSearchService(
      db as never,
      embeddings as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeAuth() as never,
    );

    const result = await svc.retrieveTopSources(makeUser(), "anything at all", 4);

    expect(result).toEqual([]);
    expect(embeddings.embedQueryWithCredit).not.toHaveBeenCalled();
  });

  it("does embed once the org has at least one indexed chunk", async () => {
    const embeddings = makeEmbeddings();
    const db = makeDb([{ id: 1 }]);
    const svc = new KbSearchService(
      db as never,
      embeddings as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeAuth() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "how do I reset my password", 6);

    expect(embeddings.embedQueryWithCredit).toHaveBeenCalled();
  });

  it("consults the canonical authorization seam for page visibility when retrieving top articles", async () => {
    const embeddings = makeEmbeddings();
    const db = makeDb([{ id: 1 }]);
    const auth = makeAuth();
    const svc = new KbSearchService(
      db as never,
      embeddings as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      auth as never,
    );

    await svc.retrieveTopArticles(makeUser(), "how do I reset my password", 6);

    expect(auth.resolveStanding).toHaveBeenCalledWith(expect.anything());
  });
});
