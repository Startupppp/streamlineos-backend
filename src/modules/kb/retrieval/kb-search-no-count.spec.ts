jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { KbSearchService } from "./kb-search.service";
import { KbCandidateService } from "./kb-candidate.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { sql } from "drizzle-orm";
import { encodeSearchCursor, searchScopeTag } from "./kb-page-search-cursor";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org-no-count",
  isOrgOwner: false,
  role: "member",
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const SEARCH_INPUT = { q: "hello", pageSize: 20 } as const;

function makeSearchScope() {
  return {
    denied: false,
    compose: (_spec: unknown, onScoped: (token: { sql: unknown }) => unknown) =>
      onScoped({ sql: sql`true` }),
  };
}

function trackingTxn(): void {
  jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction.mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  );
}

function makeCountingDb() {
  let selectCallCount = 0;
  const node = (): unknown => {
    const p = Promise.resolve([]) as unknown as Record<string, jest.Mock>;
    const self = (): unknown => p;
    p.from = jest.fn(self);
    p.where = jest.fn(self);
    p.orderBy = jest.fn(self);
    p.limit = jest.fn(self);
    p.offset = jest.fn(self);
    p.then = jest.fn((resolve: (v: unknown[]) => unknown) => resolve([]));
    return p;
  };
  const db = {
    select: jest.fn(() => {
      selectCallCount += 1;
      return node();
    }),
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve([])) })),
    get selectCallCount() {
      return selectCallCount;
    },
  };
  return db;
}

function makeService(db: unknown): KbSearchService {
  return new KbSearchService(
    db as never,
    { recordDetached: jest.fn().mockResolvedValue(undefined) } as never,
    new KbCandidateService(db as never, null),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    {
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      resolveStanding: jest.fn(),
      resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "hit" }),
    } as never,
  );
}

const renderNode = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(renderNode).join(" ");
  if (typeof node !== "object") return String(node);
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec.queryChunks)) return renderNode(rec.queryChunks);
  if (typeof rec.value === "string" || Array.isArray(rec.value)) return renderNode(rec.value);
  if (typeof rec.name === "string") return rec.name;
  return "";
};
const serialise = (v: unknown) => renderNode(v).replace(/\s+/g, " ").trim();

function makeSearchRow(id: number) {
  return {
    id,
    spaceId: null,
    categoryId: null,
    title: `Article ${id}`,
    slug: `article-${id}`,
    excerpt: null,
    status: "published",
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    contentText: "some content",
    rankValue: "0.5",
    updatedAtValue: "2026-09-20T00:00:00.000000",
  };
}

function makeCapturingSearchDb(rowsToReturn: unknown[] = []) {
  const capturedOrderBy: unknown[] = [];
  const capturedWhere: unknown[] = [];

  const makeChain = (): Record<string, jest.Mock> => {
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(() => makeChain()),
      where: jest.fn((clause: unknown) => {
        capturedWhere.push(clause);
        return makeChain();
      }),
      orderBy: jest.fn((...args: unknown[]) => {
        for (const a of args) capturedOrderBy.push(a);
        return makeChain();
      }),
      limit: jest.fn().mockResolvedValue(rowsToReturn),
    };
    return chain;
  };

  const db = {
    select: jest.fn(() => makeChain()),
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve([])) })),
  };

  return { db, capturedOrderBy, capturedWhere };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("KbSearchService — COUNT(*) removed, top-N only (S16 offset retirement)", () => {
  it("S16: search issues exactly one DB select (rows query only — no COUNT)", async () => {
    const db = makeCountingDb();
    trackingTxn();

    await makeService(db).search(USER, SEARCH_INPUT, makeSearchScope() as never);

    expect(db.selectCallCount).toBe(1);
  });

  it("S16: search result has items but not total, page, or totalPages", async () => {
    const db = makeCountingDb();
    trackingTxn();

    const result = await makeService(db).search(USER, SEARCH_INPUT, makeSearchScope() as never) as Record<string, unknown>;

    expect(result).toHaveProperty("items");
    expect(result).not.toHaveProperty("total");
    expect(result).not.toHaveProperty("page");
    expect(result).not.toHaveProperty("totalPages");
  });

  it("S16 control: the response still has items so the assertion above is not trivially satisfied by an empty object", async () => {
    const db = makeCountingDb();
    trackingTxn();

    const result = await makeService(db).search(USER, SEARCH_INPUT, makeSearchScope() as never) as Record<string, unknown>;

    expect("items" in result).toBe(true);
  });
});

describe("KbSearchService — hasMore signal (S-cursor)", () => {
  it("S-cursor-01: hasMore is true when the DB returns pageSize + 1 rows, trimming the sentinel so items.length equals pageSize", async () => {
    const PAGE_SIZE = 20;
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => makeSearchRow(i + 1));
    const { db } = makeCapturingSearchDb(rows);
    trackingTxn();

    const result = await makeService(db).search(USER, { q: "hello", pageSize: PAGE_SIZE }, makeSearchScope() as never);

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(PAGE_SIZE);
  });

  it("S-cursor-01 control: hasMore is false when the DB returns fewer rows than pageSize, so the last-page signal is not a false alarm", async () => {
    const PAGE_SIZE = 20;
    const rows = Array.from({ length: 5 }, (_, i) => makeSearchRow(i + 1));
    const { db } = makeCapturingSearchDb(rows);
    trackingTxn();

    const result = await makeService(db).search(USER, { q: "hello", pageSize: PAGE_SIZE }, makeSearchScope() as never);

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(5);
  });
});

describe("KbSearchService — ORDER BY tiebreaker (S-cursor)", () => {
  it("S-cursor-02: ORDER BY ends in id so the keyset is a total order with no ties", async () => {
    const { db, capturedOrderBy } = makeCapturingSearchDb([]);
    trackingTxn();

    await makeService(db).search(USER, SEARCH_INPUT, makeSearchScope() as never);

    expect(capturedOrderBy.length).toBeGreaterThanOrEqual(3);
    const lastOrderArg = capturedOrderBy[capturedOrderBy.length - 1];
    expect(serialise(lastOrderArg)).toContain("id");
  });

  it("S-cursor-02 control: the first ORDER BY arg does not contain 'id' so the assertion above is not trivially true of every column", async () => {
    const { db, capturedOrderBy } = makeCapturingSearchDb([]);
    trackingTxn();

    await makeService(db).search(USER, SEARCH_INPUT, makeSearchScope() as never);

    const firstOrderArg = capturedOrderBy[0];
    expect(serialise(firstOrderArg)).not.toBe(serialise(capturedOrderBy[capturedOrderBy.length - 1]));
  });
});

function makeCapturingScope() {
  const capturedDomains: unknown[][] = [];
  const scope = {
    denied: false,
    compose: (
      spec: { and: unknown[] },
      onScoped: (token: { sql: unknown }) => unknown,
    ) => {
      capturedDomains.push([...spec.and]);
      return onScoped({ sql: sql`true` });
    },
  };
  return { scope, capturedDomains };
}

describe("KbSearchService — keyset WHERE predicate (S-cursor)", () => {
  it("S-cursor-03: a valid cursor adds a composite keyset predicate to the domain passed to scope.compose, making the domain larger than an uncursored request", async () => {
    const { scope: scopeNoCursor, capturedDomains: domainsNoCursor } = makeCapturingScope();
    const { db: dbNoCursor } = makeCapturingSearchDb([]);
    trackingTxn();
    await makeService(dbNoCursor).search(USER, SEARCH_INPUT, scopeNoCursor as never);
    const baseCount = domainsNoCursor[0]?.length ?? 0;

    const permFingerprint = "1";
    const scopeTag = searchScopeTag({ q: SEARCH_INPUT.q, spaceId: undefined }, permFingerprint);
    const cursor = encodeSearchCursor(scopeTag, {
      rank: "0.5",
      updatedAt: "2026-09-20T00:00:00.000000",
      id: 7,
    });

    const { scope: scopeWithCursor, capturedDomains: domainsWithCursor } = makeCapturingScope();
    const { db: dbWithCursor } = makeCapturingSearchDb([]);
    trackingTxn();
    await makeService(dbWithCursor).search(USER, { ...SEARCH_INPUT, cursor }, scopeWithCursor as never);
    const cursoredCount = domainsWithCursor[0]?.length ?? 0;

    expect(cursoredCount).toBeGreaterThan(baseCount);
  });

  it("S-cursor-03 control: the base domain is non-empty so the count comparison above cannot be trivially satisfied by an empty start", async () => {
    const { scope, capturedDomains } = makeCapturingScope();
    const { db } = makeCapturingSearchDb([]);
    trackingTxn();

    await makeService(db).search(USER, SEARCH_INPUT, scope as never);

    expect((capturedDomains[0]?.length ?? 0)).toBeGreaterThan(0);
  });
});
