jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { KbSearchService } from "./kb-search.service";
import { KbCandidateService } from "./kb-candidate.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { sql } from "drizzle-orm";

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
