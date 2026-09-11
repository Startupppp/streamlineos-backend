import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { pageVisibleTo } from "./kb-page-visibility";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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
  it("builds page candidate queries with the reader's project-scoped visibility predicate", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const access = makeAccess();
    const service = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const user = makeUser();
    await service.retrieveTopArticles(user, "onboarding checklist", 5);

    const expected = serialize(pageVisibleTo(user, ACCESSIBLE_PROJECT_IDS));
    expect(pagePredicates(whereClauses)).toContain(expected);
  });

  it("resolves the reader's accessible projects rather than assuming none", async () => {
    const { db } = makeCapturingDb([]);
    const access = makeAccess();
    const service = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const user = makeUser();
    await service.retrieveTopArticles(user, "onboarding checklist", 5);

    expect(access.getAccessibleProjectIds).toHaveBeenCalledWith(user);
  });

  it("fetches page content with the same predicate the candidate query used", async () => {
    const { db, whereClauses } = makeCapturingDb([{ pageId: 3 }]);
    const access = makeAccess();
    const service = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const user = makeUser();
    await service.retrieveTopArticles(user, "onboarding checklist", 5);

    const expected = serialize(pageVisibleTo(user, ACCESSIBLE_PROJECT_IDS));
    const occurrences = whereClauses.filter((clause) =>
      serialize(clause).includes(expected),
    ).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("filters page attachment context through the shared page visibility predicate", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const access = makeAccess();
    const service = new KbSearchService(
      db as never,
      access as never,
      makeConfiguredEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
    );

    const user = makeUser();
    await service.retrieveAttachmentSnippets(user, "onboarding checklist", [], [3]);

    expect(access.getAccessibleProjectIds).toHaveBeenCalledWith(user);
    expect(pagePredicates(whereClauses)).toContain(
      serialize(pageVisibleTo(user, ACCESSIBLE_PROJECT_IDS)),
    );
  });
});
