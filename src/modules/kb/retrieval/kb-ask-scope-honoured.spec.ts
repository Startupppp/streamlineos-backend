import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

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

const ORG = "org-ask-scope";
const QUERY = "how does onboarding work";
const VECTOR = "[0.1,0.2]";
const CHUNK_IDS = [7, 8];
const SPACE_ID = 5;
const SOURCE_IDS_READABLE = [10, 20];
const SOURCE_ID_INACCESSIBLE = 999;
const SOURCE_ID_READABLE = 42;

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

function makeAuth(spaceIds: number[] = [SPACE_ID]) {
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

describe("KB ask scope — verifiedOnly is honoured in the keyword candidate query", () => {
  it("with verifiedOnly true the WHERE references verified_until so a page with a stale verified_until is not returned as verified content", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, true);

    const cond = getCond();
    expect(cond).toBeDefined();
    const cols = columnNames(cond);
    expect(cols).toContain("verified_until");
    expect(cols).toContain("trust_state");
  });

  it("CONTROL: without verifiedOnly the WHERE does not reference verified_until, proving the positive test is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false);

    const cond = getCond();
    expect(cond).toBeDefined();
    const cols = columnNames(cond);
    expect(cols).not.toContain("verified_until");
  });
});

describe("KB ask scope — verifiedOnly is honoured in the vector candidate query", () => {
  it("with verifiedOnly true the WHERE references verified_until so a page with a stale verified_until is not returned as verified content", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, true);

    const cond = getCond();
    expect(cond).toBeDefined();
    const cols = columnNames(cond);
    expect(cols).toContain("verified_until");
    expect(cols).toContain("trust_state");
  });

  it("CONTROL: without verifiedOnly the WHERE does not reference verified_until, proving the positive test is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false);

    const cond = getCond();
    expect(cond).toBeDefined();
    const cols = columnNames(cond);
    expect(cols).not.toContain("verified_until");
  });
});

describe("KB ask scope — sourceIds are honoured in retrieveTopSources", () => {
  it("when sourceIds is provided each id appears as a bound parameter in the WHERE", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await svc.retrieveTopSources(makeUser(), QUERY, 4, SOURCE_IDS_READABLE, {
      vectorLiteral: VECTOR,
    });

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of SOURCE_IDS_READABLE) {
      expect(rendered.params).toContain(id);
    }
  });

  it("CONTROL: without sourceIds the specific ids are absent from the WHERE, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await svc.retrieveTopSources(makeUser(), QUERY, 4, undefined, {
      vectorLiteral: VECTOR,
    });

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of SOURCE_IDS_READABLE) {
      expect(rendered.params).not.toContain(id);
    }
  });
});

describe("KB ask scope — an unreadable sourceId is not silently widened to all sources", () => {
  it("when sourceIds contains an id the actor cannot read the IN filter is still applied so the result is the empty intersection not a full unscoped search", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await svc.retrieveTopSources(makeUser(), QUERY, 4, [SOURCE_ID_INACCESSIBLE], {
      vectorLiteral: VECTOR,
    });

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    expect(rendered.params).toContain(SOURCE_ID_INACCESSIBLE);
    expect(rendered.params).toContain(ORG);
  });

  it("CONTROL: a readable sourceId also produces an IN filter and org constraint, proving the inaccessible-id assertion is not vacuous", async () => {
    const { db, getCond } = makeCaptureDb();
    const candidates = makeCandidates(db);
    const svc = makeSearchRetrieval(db, candidates);

    await svc.retrieveTopSources(makeUser(), QUERY, 4, [SOURCE_ID_READABLE], {
      vectorLiteral: VECTOR,
    });

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    expect(rendered.params).toContain(SOURCE_ID_READABLE);
    expect(rendered.params).toContain(ORG);
  });
});

const OWNER_MEMBERSHIP_ID = 77;

describe("KB ask scope — ownerMembershipId is honoured in the keyword candidate query", () => {
  it("when ownerMembershipId is provided the membership id appears as a bound parameter in the WHERE so pages owned by other members are excluded", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, OWNER_MEMBERSHIP_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(OWNER_MEMBERSHIP_ID);
  });

  it("CONTROL: without ownerMembershipId the membership id is absent from the WHERE, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).not.toContain(OWNER_MEMBERSHIP_ID);
  });
});

describe("KB ask scope — ownerMembershipId is honoured in the vector candidate query", () => {
  it("when ownerMembershipId is provided the membership id appears as a bound parameter in the WHERE so pages owned by other members are excluded", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, undefined, undefined, OWNER_MEMBERSHIP_ID);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(OWNER_MEMBERSHIP_ID);
  });

  it("CONTROL: without ownerMembershipId the membership id is absent from the WHERE, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, undefined, undefined, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).not.toContain(OWNER_MEMBERSHIP_ID);
  });
});

describe("KB ask scope — status is honoured in the keyword candidate query", () => {
  it("when status is provided the value appears as a bound parameter in the WHERE so pages in other lifecycle states are excluded", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, undefined, "published");

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain("published");
  });

  it("CONTROL: without a caller-supplied status the value 'published' is absent from the WHERE as a bound param, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, undefined, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params.filter((p) => p === "published")).toHaveLength(0);
  });
});

describe("KB ask scope — status is honoured in the vector candidate query", () => {
  it("when status is provided the value appears as a bound parameter in the WHERE so pages in other lifecycle states are excluded", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, undefined, undefined, undefined, "published");

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain("published");
  });

  it("CONTROL: without a caller-supplied status the value 'published' is absent from the WHERE as a bound param, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, undefined, undefined, undefined, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params.filter((p) => p === "published")).toHaveLength(0);
  });
});

describe("KB ask scope — caller-supplied status narrows, never widens the archived exclusion", () => {
  it("when status 'archived' is requested the WHERE contains both ne(status, 'archived') unconditionally and eq(status, 'archived') from the caller — two contradictory conditions that guarantee no archived page surfaces", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, undefined, "archived");

    const rendered = dialect.sqlToQuery(getCond());
    const archivedParams = rendered.params.filter((p) => p === "archived");
    expect(archivedParams.length).toBeGreaterThanOrEqual(2);
  });

  it("CONTROL: when status is omitted, 'archived' still appears exactly once in the WHERE from the unconditional ne filter, confirming the previous test measures a second occurrence not just the ne filter", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined, undefined, undefined, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    const archivedParams = rendered.params.filter((p) => p === "archived");
    expect(archivedParams).toHaveLength(1);
  });
});
