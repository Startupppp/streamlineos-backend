import { PgDialect } from "drizzle-orm/pg-core";
import { gte, sql, type SQL } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "../../../db/schema";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { pageVisibleTo } from "./kb-page-visibility";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const dialect = new PgDialect();
const ORG = "org-revocation";
const GRANTED_SPACES = [4, 9];
const GRANTED_PROJECTS = [7];

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(5, false),
  };
}

function render(cond: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(cond);
  return { text, params };
}

function makeCapturingDb() {
  const wheres: SQL[] = [];
  let selectCalls = 0;
  const chain = (): Record<string, jest.Mock> => {
    const rows = selectCalls++ === 0 ? [{ id: 1 }] : [];
    const self: Record<string, jest.Mock> = {
      from: jest.fn(() => self),
      innerJoin: jest.fn(() => self),
      leftJoin: jest.fn(() => self),
      orderBy: jest.fn(() => self),
      where: jest.fn((cond: SQL) => {
        wheres.push(cond);
        return self;
      }),
      limit: jest.fn().mockResolvedValue(rows),
    };
    return self;
  };
  const db = {
    select: jest.fn(() => chain()),
    // Non-empty so the vector pass reaches its own query: `pageVectorCandidates` and
    // `articleVectorCandidates` both return early on an empty candidate pool, and with []
    // only the keyword predicate would ever be captured.
    execute: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
  };
  return { db, wheres };
}

function makeAccess(spaceIds: number[], projectIds: number[], roleSlugs: string[], membershipId: number | null) {
  return {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
    getAccessibleProjectIds: jest.fn().mockResolvedValue(projectIds),
    isAdmin: jest.fn().mockResolvedValue(false),
    getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", membershipId, roleSlugs }),
  };
}

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest
    .fn()
    .mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
});

const makeEvents = () => ({ recordDetached: jest.fn().mockResolvedValue(undefined) });
const makeScopes = () => ({ scopeFor: jest.fn().mockResolvedValue("all") });

function retrieve(access: ReturnType<typeof makeAccess>) {
  const { db, wheres } = makeCapturingDb();
  const service = new KbSearchService(
    db as never,
    access as never,
    makeEmbeddings() as never,
    makeEvents() as never,
    new KbCandidateService(db as never),
    makeScopes() as never,
  );
  return {
    wheres,
    run: () => service.retrieveTopArticles(makeUser(), "deployment runbook", 4),
  };
}

const rendered = (wheres: SQL[]): string[] => wheres.map((w) => render(w).text);
const boundValues = (wheres: SQL[]): unknown[] => wheres.flatMap((w) => render(w).params);

describe("Revocation dimension 1 — space membership is re-read per query, not captured at index time", () => {
  it("asks the access service on every retrieval", async () => {
    const access = makeAccess(GRANTED_SPACES, GRANTED_PROJECTS, ["SUPPORT"], 5);
    const { run } = retrieve(access);

    await run();
    await run();

    expect(access.getAccessibleSpaceIds).toHaveBeenCalledTimes(2);
  });

  it("binds the granted spaces into the article predicate while access holds", async () => {
    const access = makeAccess(GRANTED_SPACES, GRANTED_PROJECTS, ["SUPPORT"], 5);
    const { wheres, run } = retrieve(access);

    await run();

    const articleWheres = rendered(wheres).filter((t) => t.includes(`"kb_articles"."space_id"`));
    expect(articleWheres.length).toBeGreaterThanOrEqual(2);
    expect(boundValues(wheres)).toEqual(expect.arrayContaining(GRANTED_SPACES));
  });

  it("after revocation neither the keyword nor the vector article path runs at all", async () => {
    const access = makeAccess([], GRANTED_PROJECTS, ["SUPPORT"], 5);
    const { wheres, run } = retrieve(access);

    const results = await run();

    expect(rendered(wheres).filter((t) => t.includes(`"kb_articles"`))).toEqual([]);
    expect(boundValues(wheres)).not.toEqual(expect.arrayContaining(GRANTED_SPACES));
    expect(results.filter((r) => r.kind === "article")).toEqual([]);
  });
});

describe("Revocation dimension 2 — kb_article_restrictions is a live subquery on both paths", () => {
  const candidates = new KbCandidateService(makeCapturingDb().db as never);

  it("reaches both the keyword and the vector article query", async () => {
    const access = makeAccess(GRANTED_SPACES, GRANTED_PROJECTS, ["SUPPORT"], 5);
    const { wheres, run } = retrieve(access);

    await run();

    const withRestrictions = rendered(wheres).filter((t) => t.includes("kb_article_restrictions"));
    expect(withRestrictions.length).toBeGreaterThanOrEqual(2);
  });

  it("binds the reader's membership and roles while the grant holds", () => {
    const { text, params } = render(
      candidates.articleRestrictionFilter(ORG, { userId: "user-1", membershipId: 5, roleSlugs: ["SUPPORT"] }),
    );

    expect(text).toContain("kb_article_restrictions");
    expect(text).toContain("NOT EXISTS");
    expect(params).toEqual(expect.arrayContaining([5, "SUPPORT", ORG]));
  });

  it("collapses the allow arm to false once the membership and roles are revoked", () => {
    const { text, params } = render(
      candidates.articleRestrictionFilter(ORG, { userId: "user-1", membershipId: null, roleSlugs: [] }),
    );

    expect(text).toContain("false");
    expect(params).not.toContain(5);
    expect(params).not.toContain("SUPPORT");
  });

  it("a role the reader no longer holds is not bound, so a restricted article stays out", () => {
    const before = render(
      candidates.articleRestrictionFilter(ORG, { userId: "user-1", membershipId: null, roleSlugs: ["SUPPORT"] }),
    );
    const after = render(
      candidates.articleRestrictionFilter(ORG, { userId: "user-1", membershipId: null, roleSlugs: ["OTHER"] }),
    );

    expect(before.params).toContain("SUPPORT");
    expect(after.params).not.toContain("SUPPORT");
  });
});

describe("Revocation dimension 3 — project membership is re-read per query for pages and chunks", () => {
  const user = makeUser();

  it("asks the access service on every retrieval", async () => {
    const access = makeAccess(GRANTED_SPACES, GRANTED_PROJECTS, ["SUPPORT"], 5);
    const { run } = retrieve(access);

    await run();
    await run();

    expect(access.getAccessibleProjectIds).toHaveBeenCalledTimes(2);
  });

  it("the keyword page predicate offers a project arm only while the project is granted", () => {
    const granted = render(pageVisibleTo(user, GRANTED_PROJECTS));
    const revoked = render(pageVisibleTo(user, []));

    expect(granted.text).toContain(`"kb_pages"."project_id" = ANY`);
    expect(granted.params).toContain(7);
    expect(revoked.text).not.toContain(`"kb_pages"."project_id" = ANY`);
    expect(revoked.params).not.toContain(7);
  });

  it("the vector chunk predicate loses the same arm, so an already-indexed project chunk is unreachable", () => {
    const granted = render(chunkVisibleTo(user, GRANTED_PROJECTS));
    const revoked = render(chunkVisibleTo(user, []));

    expect(granted.text).toContain(`"kb_article_chunks"."page_project_id" = ANY`);
    expect(granted.params).toContain(7);
    expect(revoked.text).not.toContain(`"kb_article_chunks"."page_project_id" = ANY`);
    expect(revoked.params).not.toContain(7);
  });

  it("both revoked predicates still bind the tenant, so nothing widens as access narrows", () => {
    for (const predicate of [pageVisibleTo(user, []), chunkVisibleTo(user, [])])
      expect(render(predicate).params).toContain(ORG);
  });
});

interface FenceFixture {
  chunkId: number;
  pageId: number;
  chunkAclRevision: number;
  pageAclRevision: number;
}

const FENCE_ROWS: FenceFixture[] = [
  { chunkId: 1, pageId: 100, chunkAclRevision: 1, pageAclRevision: 2 },
  { chunkId: 2, pageId: 101, chunkAclRevision: 1, pageAclRevision: 1 },
];

function fenceOperator(join: SQL | undefined): string | null {
  if (join === undefined) return null;
  const match =
    /"kb_article_chunks"\."acl_revision"\s*(=|>=|<=|<>|!=)\s*"kb_pages"\."acl_revision"/i.exec(
      render(join).text,
    );
  return match === null ? null : match[1];
}

function admits(operator: string | null, row: FenceFixture): boolean {
  if (operator === "=") return row.chunkAclRevision === row.pageAclRevision;
  return true;
}

function makeFenceDb() {
  const joins: SQL[] = [];
  const chain = (): Record<string, jest.Mock> => {
    const self: Record<string, jest.Mock> = {
      from: jest.fn(() => self),
      innerJoin: jest.fn((_table: unknown, cond: SQL) => {
        joins.push(cond);
        return self;
      }),
      where: jest.fn(() => self),
      orderBy: jest.fn(() => self),
      limit: jest.fn(async () => {
        const operator = fenceOperator(joins.at(-1));
        return FENCE_ROWS.filter((r) => admits(operator, r)).map((r) => ({ pageId: r.pageId }));
      }),
    };
    return self;
  };
  return {
    joins,
    db: {
      select: jest.fn(() => chain()),
      execute: jest.fn().mockResolvedValue(FENCE_ROWS.map((r) => ({ id: r.chunkId }))),
    },
  };
}

describe("The acl_revision fence drops a chunk whose revision trails its page", () => {
  it("returns only the page whose chunks are at the current revision", async () => {
    const { db, joins } = makeFenceDb();
    const candidates = new KbCandidateService(db as never);

    const pageIds = await candidates.pageVectorCandidates(ORG, "[0.1,0.2]", 4, sql`true`);

    expect(fenceOperator(joins.at(0))).toBe("=");
    expect(pageIds).toEqual([101]);
  });

  it("BITE: a tolerant fence, or none at all, hands the stale chunk's page straight back", () => {
    const tolerant = gte(kbArticleChunks.aclRevision, kbPages.aclRevision);
    expect(fenceOperator(tolerant)).toBe(">=");

    expect(FENCE_ROWS.filter((r) => admits(">=", r)).map((r) => r.pageId)).toContain(100);
    expect(FENCE_ROWS.filter((r) => admits(null, r)).map((r) => r.pageId)).toContain(100);
    expect(FENCE_ROWS.filter((r) => admits("=", r)).map((r) => r.pageId)).not.toContain(100);
  });
});
