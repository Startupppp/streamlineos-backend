import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { sql } from "drizzle-orm";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

function makeUser(orgId = "org-minority"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

function extractSqlStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const v of Object.values(node as Record<string, unknown>))
    extractSqlStrings(v, out);
  return out;
}

function makeDb(opts: { hasChunks: boolean }) {
  const chunkRows = opts.hasChunks ? [{ id: 1 }] : [];
  const settled = () => {
    const p = Promise.resolve(chunkRows) as Promise<typeof chunkRows> & Record<string, jest.Mock>;
    p.orderBy = jest.fn(() => p);
    p.limit = jest.fn().mockResolvedValue(chunkRows);
    return p;
  };
  const chain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn(settled),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(chunkRows),
  };
  const execute = jest.fn().mockImplementation((sqlNode: unknown) => {
    const text = extractSqlStrings(sqlNode).join(" ");
    if (text.includes("SET LOCAL")) return Promise.resolve([]);
    if (text.includes("kb_article_chunks")) return Promise.resolve(opts.hasChunks ? [{ id: 1 }] : []);
    if (text.includes("search_kb_chunk_ids")) return Promise.resolve(opts.hasChunks ? [{ id: 1 }] : []);
    return Promise.resolve([]);
  });
  return { db: { select: jest.fn().mockReturnValue(chain), execute } };
}

const makeAccess = () => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
});

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const makeKbAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-minority",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [1],
    accessibleProjectIds: [],
    permissionsVersion: 1,
  }),
  assertPageAccess: jest
    .fn()
    .mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
});

describe("KB ANN minority-tenant — vectorChunkIds uses plain ANN with iterative scan first", () => {
  it("issues SET LOCAL hnsw.iterative_scan = relaxed_order before any vector query", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeKbAuth() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "deployment config", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));

    const setLocalCall = sqls.find((s) => s.includes("SET LOCAL") && s.includes("relaxed_order"));
    expect(setLocalCall).toBeDefined();

    const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL"));
    const vectorIdx = sqls.findIndex((s) => s.includes("::vector"));
    expect(setLocalIdx).toBeLessThan(vectorIdx);
  });

  it("primary path uses plain ANN (ORDER BY embedding) not the fence directly", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeKbAuth() as never,
    );

    await svc.retrieveTopArticles(makeUser(), "password reset", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));
    const vectorCalls = sqls.filter((s) => s.includes("::vector") && !s.includes("SET LOCAL"));

    expect(vectorCalls.length).toBeGreaterThan(0);
    const annCall = vectorCalls.find((s) => s.includes("kb_article_chunks") && s.includes("ORDER BY"));
    expect(annCall).toBeDefined();
  });

  it("retrieveTopSources also issues SET LOCAL before the vector query", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeKbAuth() as never,
    );

    await svc.retrieveTopSources(makeUser(), "onboarding", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));

    const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL") && s.includes("relaxed_order"));
    const vectorIdx = sqls.findIndex((s) => s.includes("::vector") && !s.includes("SET LOCAL"));
    expect(setLocalIdx).toBeGreaterThanOrEqual(0);
    expect(setLocalIdx).toBeLessThan(vectorIdx);
  });
});
