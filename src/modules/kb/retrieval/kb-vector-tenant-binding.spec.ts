import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { pageVisibleTo } from "./kb-page-visibility";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-vector";
const OTHER_ORG = "org-intruder";
const VECTOR = "[0.1,0.2]";
const PRINCIPAL = { userId: "user-1", membershipId: 1, roleSlugs: ["MEMBER"] };

const dialect = new PgDialect();

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

/**
 * The kb-acl-isolation.spec pattern: render the captured PRODUCTION condition, find
 * the `$n` slot the tenant equality actually uses, and return what was bound to it —
 * a test that only greps the SQL text passes on a predicate bound to another org.
 */
function boundOrgIds(cond: SQL, table: string): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(cond);
  const pattern = new RegExp(`"${table}"\\."org_id"\\s*=\\s*\\$(\\d+)`, "g");
  return [...text.matchAll(pattern)].map((match) => params[Number(match[1]) - 1]);
}

function boundRawOrgIds(cond: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(cond);
  return [...text.matchAll(/\borg_id\s*=\s*\$(\d+)/g)].map(
    (match) => params[Number(match[1]) - 1],
  );
}

function makeHarness() {
  const wheres: SQL[] = [];
  const executed: SQL[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn(() => chain),
    limit: jest.fn().mockResolvedValue([]),
  };
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn((node: SQL) => {
      executed.push(node);
      return Promise.resolve([{ id: 3 }]);
    }),
  };
  return { db, wheres, executed, service: new KbCandidateService(db as never) };
}

describe("KB vector candidate retrieval binds the tenant in the predicate", () => {
  it("articleVectorCandidates binds the caller's org on the chunk AND the article side", async () => {
    const { service, wheres } = makeHarness();

    await service.articleVectorCandidates(ORG, [1], VECTOR, 4, PRINCIPAL, null);

    expect(wheres).toHaveLength(1);
    const where = wheres[0];
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([ORG]);
    expect(boundOrgIds(where, "kb_pages")).toEqual([ORG]);
  });

  it("pageVectorCandidates binds the caller's org on the chunk AND the page side", async () => {
    const { service, wheres } = makeHarness();

    await service.pageVectorCandidates(ORG, VECTOR, 4, chunkVisibleTo(makeUser(), []));

    expect(wheres).toHaveLength(1);
    const where = wheres[0];
    const chunkOrgs = boundOrgIds(where, "kb_article_chunks");
    expect(chunkOrgs.length).toBeGreaterThan(0);
    for (const bound of chunkOrgs) expect(bound).toBe(ORG);
    expect(boundOrgIds(where, "kb_pages")).toEqual([ORG]);
  });

  it("the bound value follows the argument, so the predicate is not a constant that happens to match", async () => {
    const { service, wheres } = makeHarness();

    await service.articleVectorCandidates(OTHER_ORG, [1], VECTOR, 4, PRINCIPAL, null);

    const where = wheres[0];
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([OTHER_ORG]);
    expect(boundOrgIds(where, "kb_pages")).toEqual([OTHER_ORG]);
    expect(boundOrgIds(where, "kb_article_chunks")).not.toContain(ORG);
  });

  it("the ANN pass that produces the candidate ids is itself tenant-bound", async () => {
    const { service, executed } = makeHarness();

    await service.vectorChunkIds(ORG, VECTOR, 8);

    const tenantBound = executed.map(boundRawOrgIds).filter((bound) => bound.length > 0);
    expect(tenantBound.length).toBeGreaterThan(0);
    for (const bound of tenantBound) expect(bound).toEqual([ORG]);
  });
});

describe("the shared visibility predicate carries the tenant for every reader", () => {
  it("chunkVisibleTo binds org_id for an ordinary member, not only for an org owner", () => {
    expect(boundOrgIds(chunkVisibleTo(makeUser(), []), "kb_article_chunks")).toEqual([ORG]);
    expect(boundOrgIds(chunkVisibleTo(makeUser(), [42]), "kb_article_chunks")).toEqual([ORG]);
    expect(
      boundOrgIds(chunkVisibleTo(makeUser({ isOrgOwner: true }), []), "kb_article_chunks"),
    ).toEqual([ORG]);
  });

  it("pageVisibleTo does the same on kb_pages, on both the scoped and the widened branch", () => {
    expect(boundOrgIds(pageVisibleTo(makeUser(), []), "kb_pages")).toEqual([ORG]);
    expect(boundOrgIds(pageVisibleTo(makeUser(), [42, 43]), "kb_pages")).toEqual([ORG]);
    expect(boundOrgIds(pageVisibleTo(makeUser({ isOrgOwner: true }), []), "kb_pages")).toEqual([
      ORG,
    ]);
  });
});
