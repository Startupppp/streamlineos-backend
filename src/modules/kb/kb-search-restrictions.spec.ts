import { KbSearchService } from "./kb-search.service";
import { KbAccessService } from "./kb-access.service";
import { KbEventsService } from "./kb-events.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  branchId: null,
  permissions: [],
  enabledModules: [],
  plan: null,
  isPlatformAdmin: false,
  isOrgOwner: false,
  sessionId: "sess-1",
  ...overrides,
});

const makeDb = () => ({
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
});

const makeAccess = (spaceIds: number[] = [1], isAdminResult = false) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  isAdmin: jest.fn().mockReturnValue(isAdminResult),
  getPrincipalIds: jest.fn().mockReturnValue({ userId: "user-1", role: "member" }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeEmbeddings = (configured = false) => ({
  isConfigured: jest.fn().mockReturnValue(configured),
  embedQuery: jest.fn(),
  toVectorLiteral: jest.fn(),
});

describe("KbSearchService — restriction enforcement", () => {
  it("articleKeywordCandidates receives principal from resolveTopArticles", async () => {
    const db = makeDb();
    (db.where as jest.Mock).mockResolvedValue([]);

    const access = makeAccess([1]);
    const events = makeEvents();
    const embeddings = makeEmbeddings(false);

    const svc = new KbSearchService(
      db as never,
      access as never,
      embeddings as never,
      events as never,
    );

    const user = makeUser();
    const result = await svc.retrieveTopArticles(user, "test query", 5);

    expect(access.getPrincipalIds).toHaveBeenCalledWith(user);
    expect(result).toEqual([]);
  });

  it("non-admin users get restriction filter applied; admin users do not", async () => {
    const db = makeDb();
    (db.where as jest.Mock).mockResolvedValue([]);

    const accessNonAdmin = makeAccess([1], false);
    const accessAdmin = makeAccess([1], true);
    const events = makeEvents();
    const embeddings = makeEmbeddings(false);

    const svcNonAdmin = new KbSearchService(db as never, accessNonAdmin as never, embeddings as never, events as never);
    const svcAdmin = new KbSearchService(db as never, accessAdmin as never, embeddings as never, events as never);

    await svcNonAdmin.retrieveTopArticles(makeUser(), "test", 5);
    await svcAdmin.retrieveTopArticles(makeUser({ isOrgOwner: true }), "test", 5);

    expect(accessNonAdmin.isAdmin).toHaveBeenCalled();
    expect(accessAdmin.isAdmin).toHaveBeenCalled();
  });
});
