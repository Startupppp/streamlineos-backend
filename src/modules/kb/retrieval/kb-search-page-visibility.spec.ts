import { sql } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const CANONICAL_SCOPE = sql`kb_canonical_scope_marker`;

const makeAuth = (spaceIds: number[] = [1]) => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(CANONICAL_SCOPE),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: spaceIds,
    accessibleProjectIds: ACCESSIBLE_PROJECT_IDS,
    permissionsVersion: 1,
  }),
  assertPageAccess: jest
    .fn()
    .mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
});

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

const ACCESSIBLE_PROJECT_IDS = [7];

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

const makeCapturingDb = (rows: unknown[] = []) => {
  const whereClauses: unknown[] = [];
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = jest.fn().mockReturnThis();
  }
  chain.where = jest.fn((clause: unknown) => {
    whereClauses.push(clause);
    return chain;
  });
  chain.limit = jest.fn().mockResolvedValue(rows);
  chain.offset = jest.fn().mockResolvedValue(rows);
  chain.then = jest.fn((resolve: (value: unknown[]) => unknown) => resolve(rows));
  return {
    whereClauses,
    db: {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    },
  };
};

const makeAccess = (spaceIds: number[] = [1]) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE_PROJECT_IDS),
  isAdmin: jest.fn().mockReturnValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: ["MEMBER"] }),
});

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  embedQueryWithCredit: jest.fn(),
});

const makeConfiguredEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const render = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (typeof node !== "object") return String(node);

  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return render(record.queryChunks);
  if (typeof record.value === "string" || Array.isArray(record.value))
    return render(record.value);
  if (typeof record.name === "string") return record.name;
  return "";
};

const serialize = (value: unknown): string =>
  render(value).replace(/\s+/g, " ").trim();

const pagePredicates = (whereClauses: unknown[]): string =>
  whereClauses.map(serialize).join("\n");

describe("KbSearchService — page retrieval crosses the visibility seam", () => {
  const makeService = (
    db: unknown,
    auth: unknown,
    embeddings = makeEmbeddings(),
  ) =>
    new KbSearchService(
      db as never,
      embeddings as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      auth as never,
    );

  it("resolves standing from the canonical seam to build the page visibility predicate", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).retrieveTopArticles(
      makeUser(),
      "onboarding checklist",
      5,
    );

    expect(auth.resolveStanding).toHaveBeenCalledWith(expect.anything());
  });

  it("asks the canonical seam once per retrieveTopArticles call so the predicate is not computed per row", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();
    const user = makeUser();

    await makeService(db, auth).retrieveTopArticles(
      user,
      "onboarding checklist",
      5,
    );

    expect(auth.resolveStanding).toHaveBeenCalledWith(user);
    expect(auth.resolveStanding).toHaveBeenCalledTimes(1);
  });

  it("resolves the reader's accessible projects from standing for chunk-scoped visibility", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();
    const user = makeUser();

    await makeService(db, auth).retrieveTopArticles(
      user,
      "onboarding checklist",
      5,
    );

    expect(auth.resolveStanding).toHaveBeenCalledWith(user);
  });

  it("resolves standing once so the candidate query and the content fetch share the same predicate", async () => {
    const { db } = makeCapturingDb([{ pageId: 3 }]);
    const auth = makeAuth();

    await makeService(db, auth).retrieveTopArticles(
      makeUser(),
      "onboarding checklist",
      5,
    );

    expect(auth.resolveStanding).toHaveBeenCalledTimes(1);
  });

  it("filters page attachment context through the canonical seam as well", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();
    const user = makeUser();

    await makeService(
      db,
      auth,
      makeConfiguredEmbeddings(),
    ).retrieveDocumentPassages(user, "onboarding checklist", [], [3]);

    expect(auth.visiblePagePredicate).toHaveBeenCalledWith(user, "view");
    expect(pagePredicates(whereClauses)).toContain(serialize(CANONICAL_SCOPE));
  });
});
