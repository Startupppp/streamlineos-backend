jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (
    _db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => fn(_db),
}));

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbRetrievalService } from "./kb-retrieval.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-space-scope";
const QUERY = "how does onboarding work";
const VECTOR = "[0.1,0.2]";
const CHUNK_IDS = [7, 8];
const TEST_SPACE_ID = 37;
const ACCESSIBILITY_SENTINEL = 99001;
const VISIBILITY_SENTINEL = 98765;

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function visibilityPredicate(): SQL {
  return sql`kb_pages.space_id = ${VISIBILITY_SENTINEL}`;
}

function makeSelectChain(captureCond: (cond: unknown) => void): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn((cond: unknown) => {
    captureCond(cond);
    return chain;
  });
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue([]);
  return chain;
}

function makeCaptureDb(): { db: Db; getCond: () => SQL } {
  let capturedCond: unknown;
  const chain = makeSelectChain((cond) => {
    capturedCond = cond;
  });
  const db = {
    select: jest.fn().mockReturnValue(chain),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, getCond: () => capturedCond as SQL };
}

function makeCandidates(db: Db): KbCandidateService {
  const svc = new KbCandidateService(db, null);
  jest.spyOn(svc, "hasEmbeddedChunks").mockResolvedValue(true);
  jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);
  return svc;
}

function makeAuth(spaceIds: number[] = [ACCESSIBILITY_SENTINEL]) {
  return {
    resolveStanding: jest.fn().mockResolvedValue({
      accessibleSpaceIds: spaceIds,
      accessibleProjectIds: [],
      orgId: ORG,
      userId: "user-1",
      membershipId: 1,
      roleSlugs: [],
      isOrgOwner: false,
      isKbAdmin: false,
      permissionsVersion: 1,
    }),
    articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  };
}

function makeSearchRetrieval(
  db: Db,
  candidates: KbCandidateService,
  auth = makeAuth(),
): KbSearchRetrievalService {
  return new KbSearchRetrievalService(
    db,
    {
      isEmbeddingConfigured: jest.fn(() => true),
      embedQueryWithCredit: jest
        .fn()
        .mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: VECTOR }),
    } as never,
    candidates,
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    auth as never,
    null,
  );
}

describe("KB space scope — spaceId reaches the page keyword candidate WHERE predicate", () => {
  it("when spaceId is supplied the bound value appears in the WHERE so the query is constrained to that space", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await (svc as never as KbCandidateService & { pageKeywordCandidates(...args: unknown[]): Promise<number[]> })
      .pageKeywordCandidates(ORG, QUERY, 10, visibilityPredicate(), false, undefined, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
  });

  it("CONTROL: without spaceId the space id is absent from the WHERE, so the positive test above is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, visibilityPredicate(), false, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).not.toContain(TEST_SPACE_ID);
  });

  it("spaceId is ANDed with the visibility predicate so the space constraint cannot displace the access-control predicate", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await (svc as never as KbCandidateService & { pageKeywordCandidates(...args: unknown[]): Promise<number[]> })
      .pageKeywordCandidates(ORG, QUERY, 10, visibilityPredicate(), false, undefined, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
  });
});

describe("KB space scope — spaceId reaches the page vector candidate WHERE predicate", () => {
  it("when spaceId is supplied the bound value appears in the WHERE so the query is constrained to that space", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await (svc as never as KbCandidateService & { pageVectorCandidates(...args: unknown[]): Promise<number[]> })
      .pageVectorCandidates(ORG, VECTOR, 10, visibilityPredicate(), false, undefined, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
  });

  it("CONTROL: without spaceId the space id is absent from the WHERE, so the positive test above is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, visibilityPredicate(), false, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).not.toContain(TEST_SPACE_ID);
  });

  it("spaceId is ANDed with the chunk-visibility predicate so the space constraint cannot displace the access-control predicate", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await (svc as never as KbCandidateService & { pageVectorCandidates(...args: unknown[]): Promise<number[]> })
      .pageVectorCandidates(ORG, VECTOR, 10, visibilityPredicate(), false, undefined, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
  });
});

describe("KB space scope — spaceId reaches the retrieveTopSources WHERE predicate", () => {
  it("when spaceId is supplied the bound value appears in the WHERE so source results are also space-scoped", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await (svc as never as KbSearchRetrievalService & { retrieveTopSources(...args: unknown[]): Promise<unknown[]> })
      .retrieveTopSources(makeUser(), QUERY, 4, undefined, { vectorLiteral: VECTOR }, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
  });

  it("CONTROL: without spaceId the space id is absent from the retrieveTopSources WHERE, so the positive test is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await svc.retrieveTopSources(makeUser(), QUERY, 4, undefined, { vectorLiteral: VECTOR });

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).not.toContain(TEST_SPACE_ID);
  });

  it("spaceId is ANDed with the space-accessibility filter so the requested scope can only narrow what is already visible", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await (svc as never as KbSearchRetrievalService & { retrieveTopSources(...args: unknown[]): Promise<unknown[]> })
      .retrieveTopSources(makeUser(), QUERY, 4, undefined, { vectorLiteral: VECTOR }, TEST_SPACE_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(TEST_SPACE_ID);
    expect(rendered.params).toContain(ACCESSIBILITY_SENTINEL);
  });
});

describe("KbRetrievalService.retrieve — spaceId is forwarded to retrieveTopSources", () => {
  it("when spaceId is in the options retrieve forwards it to retrieveTopSources so source results are also space-scoped", async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([{ one: 1, chunk_count: 0 }]),
    };
    const search = {
      resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: VECTOR }),
      retrieveTopArticles: jest.fn().mockResolvedValue([]),
      retrieveTopSources: jest.fn().mockResolvedValue([]),
      retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
      retrieveTopSourcesWithOutcome: jest
        .fn()
        .mockResolvedValue({ kind: "ok", results: [] }),
      retrieveDocumentPassagesWithOutcome: jest
        .fn()
        .mockResolvedValue({ kind: "ok", results: [] }),
    };
    const service = new KbRetrievalService(db as never, search as never, null);

    await service.retrieve(makeUser(), QUERY, { spaceId: TEST_SPACE_ID });

    expect(search.retrieveTopSourcesWithOutcome).toHaveBeenCalledWith(
      expect.anything(),
      QUERY,
      expect.any(Number),
      undefined,
      expect.anything(),
      TEST_SPACE_ID,
    );
  });

  it("CONTROL: without spaceId in options retrieveTopSources is called with undefined as its sixth argument, confirming the positive test above is not a tautology", async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([{ one: 1, chunk_count: 0 }]),
    };
    const search = {
      resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: VECTOR }),
      retrieveTopArticles: jest.fn().mockResolvedValue([]),
      retrieveTopSources: jest.fn().mockResolvedValue([]),
      retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
      retrieveTopSourcesWithOutcome: jest
        .fn()
        .mockResolvedValue({ kind: "ok", results: [] }),
      retrieveDocumentPassagesWithOutcome: jest
        .fn()
        .mockResolvedValue({ kind: "ok", results: [] }),
    };
    const service = new KbRetrievalService(db as never, search as never, null);

    await service.retrieve(makeUser(), QUERY, {});

    expect(search.retrieveTopSourcesWithOutcome).toHaveBeenCalledWith(
      expect.anything(),
      QUERY,
      expect.any(Number),
      undefined,
      expect.anything(),
      undefined,
    );
  });
});
