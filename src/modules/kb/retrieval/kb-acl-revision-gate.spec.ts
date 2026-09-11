import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

const dialect = new PgDialect();

const STRICT_FENCE =
  /"kb_article_chunks"\."acl_revision" = "(kb_articles|kb_pages)"\."acl_revision"/;

/**
 * Every way SQL can be talked out of denying a stale chunk: a null-tolerant
 * comparison, an explicit null escape arm, a default, or an inequality that lets a
 * trailing revision through.
 */
const NULL_ESCAPES = [/IS NOT DISTINCT FROM/i, /\bis null\b/i, /coalesce/i, />=|<=|<>|!=/i];

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function renderSql(cond: SQL): string {
  return dialect.sqlToQuery(cond).sql;
}

function expectStrictFence(rendered: string): void {
  expect(rendered).toMatch(STRICT_FENCE);
  for (const escape of NULL_ESCAPES) expect(rendered).not.toMatch(escape);
}

const makeAccess = (spaceIds = [1]) => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue(spaceIds),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", membershipId: 1, roleSlugs: [] }),
});

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
  embedQueryWithCredit: jest
    .fn()
    .mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
});

const makeEvents = () => ({ recordDetached: jest.fn().mockResolvedValue(undefined) });

function makeJoinCapturingDb() {
  const joins: SQL[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn((_table: unknown, cond: SQL) => {
      joins.push(cond);
      return chain;
    }),
    leftJoin: jest.fn(() => {
      throw new Error("leftJoin must not be used for the ACL revision gate");
    }),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn().mockResolvedValue([]),
  };

  const probe: Record<string, jest.Mock> = {
    from: jest.fn(() => probe),
    where: jest.fn(() => probe),
    orderBy: jest.fn(() => probe),
    limit: jest.fn().mockResolvedValue([{ id: 1 }]),
  };

  let selectCalls = 0;
  const db = {
    select: jest.fn(() => (selectCalls++ === 0 ? probe : chain)),
    execute: jest.fn().mockResolvedValue([{ id: 7 }]),
  };

  return { db, joins };
}

function makeService(db: unknown, spaceIds: number[]): KbSearchService {
  return new KbSearchService(
    db as never,
    makeAccess(spaceIds) as never,
    makeEmbeddings() as never,
    makeEvents() as never,
    new KbCandidateService(db as never),
    makeScopes() as never,
  );
}

describe("KB ACL revision gate — stale chunks cannot surface in vector search", () => {
  it("articleVectorCandidates joins on a plain revision equality, with no arm that admits a NULL", async () => {
    const { db, joins } = makeJoinCapturingDb();

    await makeService(db, [1]).retrieveTopArticles(makeUser(), "deployment guide", 4);

    expect(joins.length).toBeGreaterThanOrEqual(2);
    const rendered = joins.map(renderSql);
    for (const text of rendered) expectStrictFence(text);
    expect(rendered.some((text) => text.includes('"kb_articles"."acl_revision"'))).toBe(true);
    expect(rendered.some((text) => text.includes('"kb_pages"."acl_revision"'))).toBe(true);
  });

  it("pageVectorCandidates joins on the same plain equality, so a page chunk that trails its page is dropped", async () => {
    const { db, joins } = makeJoinCapturingDb();

    await makeService(db, []).retrieveTopArticles(makeUser(), "onboarding workflow", 4);

    expect(joins.length).toBeGreaterThanOrEqual(1);
    const rendered = joins.map(renderSql);
    for (const text of rendered) expectStrictFence(text);
    expect(rendered.every((text) => text.includes('"kb_pages"."acl_revision"'))).toBe(true);
  });

  it("BITE: the assertion rejects the null-escape arm it exists to forbid", () => {
    const nullEscape =
      '("kb_articles"."id" = "kb_article_chunks"."article_id" and ("kb_article_chunks"."acl_revision" = "kb_articles"."acl_revision" or "kb_article_chunks"."acl_revision" is null))';
    expect(() => expectStrictFence(nullEscape)).toThrow();
  });
});
