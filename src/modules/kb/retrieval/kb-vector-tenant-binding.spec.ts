import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-vector";
const OTHER_ORG = "org-intruder";
const VECTOR = "[0.1,0.2]";

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

function makeStanding(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: 1,
    roleSlugs: ["MEMBER"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [],
    accessibleProjectIds: [],
    permissionsVersion: 1,
    ...overrides,
  };
}

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

    await service.articleVectorCandidates(ORG, [1], VECTOR, 4, null, null);

    expect(wheres).toHaveLength(1);
    const where = wheres[0];
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([ORG]);
    expect(boundOrgIds(where, "kb_pages")).toEqual([ORG]);
  });

  it("pageVectorCandidates binds the caller's org on the chunk AND the page side", async () => {
    const { service, wheres } = makeHarness();

    await service.pageVectorCandidates(ORG, VECTOR, 4, chunkVisibleTo(makeStanding()));

    expect(wheres).toHaveLength(1);
    const where = wheres[0];
    const chunkOrgs = boundOrgIds(where, "kb_article_chunks");
    expect(chunkOrgs.length).toBeGreaterThan(0);
    for (const bound of chunkOrgs) expect(bound).toBe(ORG);
    const pageOrgs = boundOrgIds(where, "kb_pages");
    expect(pageOrgs.length).toBeGreaterThan(0);
    for (const bound of pageOrgs) expect(bound).toBe(ORG);
  });

  it("the bound value follows the argument, so the predicate is not a constant that happens to match", async () => {
    const { service, wheres } = makeHarness();

    await service.articleVectorCandidates(OTHER_ORG, [1], VECTOR, 4, null, null);

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
  it("chunkVisibleTo binds org_id through the page reference for an ordinary member and for an org owner", () => {
    const pages0 = boundOrgIds(chunkVisibleTo(makeStanding()), "kb_pages");
    expect(pages0.length).toBeGreaterThan(0);
    for (const bound of pages0) expect(bound).toBe(ORG);

    const pages1 = boundOrgIds(chunkVisibleTo(makeStanding({ accessibleProjectIds: [42] })), "kb_pages");
    expect(pages1.length).toBeGreaterThan(0);
    for (const bound of pages1) expect(bound).toBe(ORG);

    const pages2 = boundOrgIds(chunkVisibleTo(makeStanding({ isOrgOwner: true })), "kb_pages");
    expect(pages2.length).toBeGreaterThan(0);
    for (const bound of pages2) expect(bound).toBe(ORG);
  });

  it("the canonical page scope does the same on kb_pages, on the narrow, the project-widened and the admin branch", () => {
    expect(boundOrgIds(buildVisiblePageScope(makeStanding(), "view").predicate, "kb_pages")).toEqual(
      [ORG],
    );
    expect(
      boundOrgIds(
        buildVisiblePageScope(makeStanding({ accessibleProjectIds: [42, 43] }), "view").predicate,
        "kb_pages",
      ),
    ).toEqual([ORG]);
    expect(
      boundOrgIds(
        buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view").predicate,
        "kb_pages",
      ),
    ).toEqual([ORG]);
  });

  it("every separately addressable arm of the canonical page scope carries the tenant, so a union of arms cannot widen past it", () => {
    const scope = buildVisiblePageScope(
      makeStanding({ accessibleSpaceIds: [3], accessibleProjectIds: [42] }),
      "view",
    );

    expect(boundOrgIds(scope.indexedBranch, "kb_pages")).toEqual([ORG]);
    expect(scope.grantBranch).not.toBeNull();
    expect(boundOrgIds(scope.grantBranch as SQL, "kb_pages")).toEqual([ORG]);
    expect(boundOrgIds(scope.grantBranch as SQL, "kb_page_grants")).toEqual([ORG]);
  });

  it("the bound tenant follows the standing, so the page scope is not a constant that happens to match", () => {
    const other = buildVisiblePageScope(makeStanding({ orgId: OTHER_ORG }), "view");

    expect(boundOrgIds(other.predicate, "kb_pages")).toEqual([OTHER_ORG]);
    expect(boundOrgIds(other.predicate, "kb_pages")).not.toContain(ORG);
  });
});
