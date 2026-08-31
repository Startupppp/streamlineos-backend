import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

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
  const execute = jest.fn().mockResolvedValue([]);
  return { db: { select: jest.fn().mockReturnValue(chain), execute } };
}

const makeAccess = () => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
});

const makeEmbeddings = () => ({
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
  toVectorLiteral: jest.fn().mockReturnValue("[0.1,0.2]"),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

describe("KB ANN minority-tenant — vectorChunkIds always uses the SECURITY DEFINER fence", () => {
  it("emits no bare global ORDER-BY-embedding execute call", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchService(
      db as never,
      makeAccess() as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
    );

    await svc.retrieveTopArticles(makeUser(), "deployment config", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));

    const bareGlobalAnn = sqls.filter(
      (s) =>
        s.includes("ORDER BY embedding") &&
        !s.includes("search_kb_chunk_ids") &&
        !s.includes("search_kb_"),
    );
    expect(bareGlobalAnn).toHaveLength(0);
  });

  it("every vector execute call routes through search_kb_chunk_ids", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchService(
      db as never,
      makeAccess() as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
    );

    await svc.retrieveTopArticles(makeUser(), "password reset", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));
    const vectorCalls = sqls.filter((s) => s.includes("::vector"));

    expect(vectorCalls.length).toBeGreaterThan(0);
    vectorCalls.forEach((s) => expect(s).toContain("search_kb_chunk_ids"));
  });

  it("retrieveTopSources vector call also routes through search_kb_chunk_ids", async () => {
    const { db } = makeDb({ hasChunks: true });
    const svc = new KbSearchService(
      db as never,
      makeAccess() as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
    );

    await svc.retrieveTopSources(makeUser(), "onboarding", 4);

    const calls = (db.execute as jest.Mock).mock.calls as Array<[unknown]>;
    const sqls = calls.map(([arg]) => extractSqlStrings(arg).join(" "));
    const vectorCalls = sqls.filter((s) => s.includes("::vector"));

    expect(vectorCalls.length).toBeGreaterThan(0);
    vectorCalls.forEach((s) => expect(s).toContain("search_kb_chunk_ids"));
  });
});
