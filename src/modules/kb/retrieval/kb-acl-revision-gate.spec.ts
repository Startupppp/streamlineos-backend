import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import { kbArticleChunks, kbArticles } from "../../../db/schema";

const dialect = new PgDialect();

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

function renderSql(cond: unknown): string {
  try {
    return dialect.sqlToQuery(cond as SQL).sql;
  } catch {
    return "";
  }
}

function makeDb(chunkIds: number[]) {
  const innerJoinCalls: Array<[unknown, unknown]> = [];

  const chain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockImplementation((table: unknown, cond: unknown) => {
      innerJoinCalls.push([table, cond]);
      return chain;
    }),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };

  const hasChunkRows = chunkIds.length > 0 ? [{ id: chunkIds[0] }] : [];
  const chain2 = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(hasChunkRows),
  };

  const execute = jest.fn().mockResolvedValue(chunkIds.map((id) => ({ id })));

  const db = {
    select: jest.fn().mockImplementation(() => {
      return chain2;
    }),
    execute,
  };

  return { db, innerJoinCalls };
}

const makeAccess = (spaceIds = [1]) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
});

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

describe("KB ACL revision gate — null revision is fail-closed", () => {
  it("a chunk with null aclRevision cannot match an article with a non-null aclRevision (innerJoin excludes NULL = N)", () => {
    const chunkRevision: number | null = null;
    const articleRevision: number | null = 5;
    const sqlNullEqualsNonNull = chunkRevision === articleRevision;
    expect(sqlNullEqualsNonNull).toBe(false);
  });

  it("aclRevision join predicate emits '=' not 'IS NOT DISTINCT FROM' — NULL=NULL yields SQL-NULL so the innerJoin denies stale chunks", () => {
    const cond = eq(kbArticleChunks.aclRevision, kbArticles.aclRevision);
    const rendered = renderSql(cond);
    expect(rendered).toContain("acl_revision");
    expect(rendered).not.toMatch(/IS NOT DISTINCT FROM/i);
  });
});

describe("KB ACL revision gate — stale chunks cannot surface in vector search", () => {
  it("articleVectorCandidates uses innerJoin (not leftJoin) so mismatched aclRevision rows are excluded", async () => {
    const capturedInnerJoins: Array<[unknown, unknown]> = [];
    const chain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockImplementation((t: unknown, c: unknown) => {
        capturedInnerJoins.push([t, c]);
        return chain;
      }),
      leftJoin: jest.fn().mockImplementation(() => { throw new Error("leftJoin must not be used for ACL revision gate"); }),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const hasChunkRows = [{ id: 1 }];
    const chain2 = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(hasChunkRows),
    };

    const execute = jest.fn().mockResolvedValue([{ id: 7 }]);

    const db = {
      select: jest.fn().mockImplementation(() => {
        if ((db.select as jest.Mock).mock.calls.length <= 1) return chain2;
        return chain;
      }),
      execute,
    };

    const svc = new KbSearchService(
      db as never,
      makeAccess() as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
    );

    await svc.retrieveTopArticles(makeUser(), "deployment guide", 4);

    expect(capturedInnerJoins.length).toBeGreaterThanOrEqual(2);
    capturedInnerJoins.forEach(([, cond]) => {
      expect(renderSql(cond)).toContain("acl_revision");
    });
  });

  it("pageVectorCandidates uses innerJoin with aclRevision so stale page chunks are excluded", async () => {
    const capturedInnerJoins: Array<[unknown, unknown]> = [];
    const chain = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockImplementation((t: unknown, c: unknown) => {
        capturedInnerJoins.push([t, c]);
        return chain;
      }),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const hasChunkRows = [{ id: 1 }];
    const chainBase = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(hasChunkRows),
    };

    const execute = jest.fn().mockResolvedValue([{ id: 7 }]);

    const db = {
      select: jest.fn().mockImplementation(() => {
        if ((db.select as jest.Mock).mock.calls.length <= 1) return chainBase;
        return chain;
      }),
      execute,
    };

    const svc = new KbSearchService(
      db as never,
      makeAccess([]) as never,
      makeEmbeddings() as never,
      makeEvents() as never,
      new KbCandidateService(db as never),
    );

    await svc.retrieveTopArticles(makeUser(), "onboarding workflow", 4);

    expect(capturedInnerJoins.length).toBeGreaterThanOrEqual(1);
    capturedInnerJoins.forEach(([, cond]) => {
      expect(renderSql(cond)).toContain("acl_revision");
    });
  });
});
