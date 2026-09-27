jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbSearchController } from "./kb-search.controller";
import { KbSearchService } from "./kb-search.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbPageSearchQueryService } from "./kb-page-search-query.service";
import { KbCandidateService } from "./kb-candidate.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";

const ORG = "org-search-release";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function txnMock(): jest.Mock {
  return jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction;
}

const txnDepth = { value: 0 };

function trackingTxn(): void {
  txnMock().mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      txnDepth.value += 1;
      try {
        return await fn({});
      } finally {
        txnDepth.value -= 1;
      }
    },
  );
}

type QueryNode = Promise<unknown[]> & {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
};

function makeDb(): Db {
  const node = (): QueryNode => {
    const p = Promise.resolve([]) as unknown as QueryNode;
    p.from = jest.fn(() => node());
    p.where = jest.fn(() => node());
    p.orderBy = jest.fn(() => node());
    p.limit = jest.fn(() => node());
    p.offset = jest.fn(() => Promise.resolve([]));
    return p;
  };
  return {
    select: jest.fn(() => node()),
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve([])) })),
  } as unknown as Db;
}

function makeSearchScope() {
  return {
    denied: false,
    compose: (_spec: unknown, onScoped: (token: { sql: unknown }) => unknown) =>
      onScoped({ sql: sql`true` }),
  };
}

function makeKbAdminStanding() {
  return {
    orgId: ORG,
    userId: USER.userId,
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: true,
    accessibleSpaceIds: [],
    accessibleProjectIds: [],
    permissionsVersion: 1,
  };
}

function makeSearchService(db: Db): KbSearchService {
  return new KbSearchService(
    db,
    { recordDetached: jest.fn().mockReturnValue(Promise.resolve()) } as never,
    new KbCandidateService(db, null),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    {
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      resolveStanding: jest.fn().mockResolvedValue(makeKbAdminStanding()),
      resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "hit" }),
    } as never,
  );
}

function makeSearchRetrievalService(db: Db, embedDepths: number[]): KbSearchRetrievalService {
  return new KbSearchRetrievalService(
    db,
    {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest.fn(async () => {
        embedDepths.push(txnDepth.value);
        return { ok: true as const, vectorLiteral: "[0.1,0.2]" };
      }),
    } as never,
    new KbCandidateService(db, null),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    {
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      resolveStanding: jest.fn().mockResolvedValue(makeKbAdminStanding()),
      resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "hit" }),
    } as never,
    null,
  );
}

function makePageSearchService(db: Db): KbPageSearchQueryService {
  return new KbPageSearchQueryService(db, {
    resolveStanding: jest.fn().mockResolvedValue(makeKbAdminStanding()),
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  } as never);
}

beforeEach(() => {
  txnDepth.value = 0;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("KbSearchController — both search routes opt out of the ambient tenant transaction", () => {
  it("GET /kb/search carries @NoTenantTransaction() so the pooled connection is not held during scope resolution or query execution", () => {
    const handler: unknown = Reflect.get(KbSearchController.prototype, "searchArticles");

    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });

  it("GET /kb/pages/full-search carries @NoTenantTransaction() for the same reason", () => {
    const handler: unknown = Reflect.get(KbSearchController.prototype, "searchPages");

    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });

  it("a bare function carries no @NoTenantTransaction() metadata, so the assertions above read a real decorator and not a default", () => {
    function bare() {}

    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, bare)).toBeUndefined();
  });
});

describe("KbSearchService.search — re-enters the tenant transaction for all DB work", () => {
  it("calls runInTenantTransaction with the caller orgId so the first DB statement carries a tenant GUC", async () => {
    const db = makeDb();
    trackingTxn();

    const svc = makeSearchService(db);
    await svc.search(USER, { q: "hello world", pageSize: 20 }, makeSearchScope() as never);

    expect(txnMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
  });

  it("calls runInTenantTransaction exactly once per search so the connection is not borrowed outside the DB work window", async () => {
    const db = makeDb();
    trackingTxn();

    const svc = makeSearchService(db);
    await svc.search(USER, { q: "hello world", pageSize: 20 }, makeSearchScope() as never);

    expect(txnMock()).toHaveBeenCalledTimes(1);
  });
});

describe("KbSearchRetrievalService.resolveQueryEmbedding — provider call must run outside the tenant transaction boundary", () => {
  it("embedQueryWithCredit is called at transaction depth 0 so a provider brown-out never parks a pooled connection", async () => {
    const embedDepths: number[] = [];
    const db = makeDb();
    trackingTxn();

    const svc = makeSearchRetrievalService(db, embedDepths);
    await svc.resolveQueryEmbedding("how do I reset my password", ORG);

    expect(embedDepths).toHaveLength(1);
    expect(embedDepths).toEqual([0]);
  });

  it("MUTATION-PROOF — wrapping resolveQueryEmbedding inside runInTenantTransaction produces depth 1, proving the ordering assertion above would catch that regression", async () => {
    const embedDepths: number[] = [];
    const db = makeDb();
    trackingTxn();

    const svc = makeSearchRetrievalService(db, embedDepths);
    await runInTenantTransaction(
      db,
      () => svc.resolveQueryEmbedding("how do I reset my password", ORG),
      { orgId: ORG },
    );

    expect(embedDepths).toEqual([1]);
  });
});

describe("KbPageSearchQueryService.search — re-enters the tenant transaction for all DB work", () => {
  it("calls runInTenantTransaction with the caller orgId so the first DB statement carries a tenant GUC", async () => {
    const db = makeDb();
    trackingTxn();

    const svc = makePageSearchService(db);
    await svc.search(USER, {
      q: "hello",
      cursor: undefined,
      limit: 20,
      facets: false,
    } as never);

    expect(txnMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
  });

  it("the early return on an empty tsquery exits before runInTenantTransaction, so no connection is borrowed for a no-op query", async () => {
    const db = makeDb();
    trackingTxn();

    const svc = makePageSearchService(db);
    const result = await svc.search(USER, {
      q: "",
      cursor: undefined,
      limit: 20,
      facets: false,
    } as never);

    expect(result.items).toEqual([]);
    expect(txnMock()).not.toHaveBeenCalled();
  });
});
