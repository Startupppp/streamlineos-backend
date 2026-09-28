import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

function chunksOf(node: unknown): unknown[] | null {
  if (node === null || typeof node !== "object") return null;
  const c = (node as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(c) ? c : null;
}

function columnNames(node: unknown, out: string[] = []): string[] {
  const chunks = chunksOf(node);
  if (chunks !== null) {
    for (const c of chunks) columnNames(c, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const record = node as { name?: unknown; table?: unknown };
  if (typeof record.name === "string" && record.table !== undefined) out.push(record.name);
  return out;
}

describe("KbCandidateService — verifiedOnly scope", () => {
  it("references verified_until in the where predicate when verifiedOnly=true, so a page with trust_state=verified but a past verified_until is excluded rather than returned as verified content", async () => {
    const whereClauses: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn((clause: unknown) => {
        whereClauses.push(clause);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };

    const svc = new KbCandidateService(db as never);
    await svc.pageKeywordCandidates("org-1", "test query", 10, sql`true`, true);

    const combined = whereClauses.flatMap((c) => columnNames(c)).join(" ");
    expect(combined).toContain("verified_until");
    expect(combined).toContain("trust_state");
  });

  it("does not include verified_until in the predicate when verifiedOnly is not set — positive pair showing the column appears only when the scope requires it", async () => {
    const whereClauses: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn((clause: unknown) => {
        whereClauses.push(clause);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 5 }]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };

    const svc = new KbCandidateService(db as never);
    const ids = await svc.pageKeywordCandidates("org-1", "test query", 10, sql`true`);

    expect(ids).toEqual([5]);
    const combined = whereClauses.flatMap((c) => columnNames(c)).join(" ");
    expect(combined).not.toContain("verified_until");
  });
});

describe("KbCandidateService — archived pages are excluded before the candidate limit", () => {
  function capturePageCandidateQuery() {
    const whereClauses: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn((clause: unknown) => {
        whereClauses.push(clause);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    return {
      service: new KbCandidateService(db as never),
      limit: chain.limit,
      rendered: () =>
        whereClauses.map((c) => new PgDialect().sqlToQuery(c as never)),
    };
  }

  it("pageKeywordCandidates excludes archived inside the same query that applies the limit, so archived rows cannot consume candidate slots and starve the answer of context", async () => {
    const harness = capturePageCandidateQuery();

    await harness.service.pageKeywordCandidates("org-1", "test query", 10, sql`true`);
    const queries = harness.rendered();

    expect(queries.some((q) => /"status"\s*<>/.test(q.sql))).toBe(true);
    expect(queries.flatMap((q) => q.params)).toContain("archived");
  });

  it("the exclusion sits in the query that is limited rather than a later one — the same call applies its limit, so filtering after the fact could not have had the same effect", async () => {
    const harness = capturePageCandidateQuery();

    await harness.service.pageKeywordCandidates("org-1", "test query", 10, sql`true`);

    expect(harness.limit).toHaveBeenCalledWith(10);
    expect(harness.rendered()).toHaveLength(1);
  });
});
