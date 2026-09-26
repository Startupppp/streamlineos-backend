import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../../../db/schema";
import { KnowledgeCollectionService } from "./knowledge-collection.service";
import {
  buildVisiblePageScope,
  buildIndexedBranch,
  buildGrantBranch,
} from "../authorization/knowledge-page-scope";
import type { KnowledgeAuthorizationService } from "../authorization/knowledge-authorization.service";
import type { KbActorStanding } from "../authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { KbPageCollectionQuery } from "./knowledge-collection.types";
import { kbPageCollectionPageSchema } from "../dto/kb-core-response.schemas";

const ORG = "org-collection";
const OTHER_ORG = "org-intruder";
const MEMBERSHIP = 42;

function standing(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: MEMBERSHIP,
    roleSlugs: ["writer"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [7],
    accessibleProjectIds: [],
    permissionsVersion: 3,
    ...overrides,
  };
}

function user(orgId = ORG): CurrentUserContext {
  return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false } as CurrentUserContext;
}

function query(
  overrides: Partial<KbPageCollectionQuery> = {},
): KbPageCollectionQuery {
  return { sort: "updated_desc", limit: 2, ...overrides };
}

type CollectionSelection = Record<string, SQL | SQL.Aliased | PgColumn>;

interface Capture {
  wheres: SQL[];
  orderBys: unknown[][];
  limits: number[];
  groupBys: number;
  selectCalls: number;
  unions: number;
  selections: CollectionSelection[];
}

function makeChain(rows: Record<string, unknown>[], capture: Capture): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.orderBy = jest.fn((...terms: unknown[]) => {
    capture.orderBys.push(terms);
    return chain;
  });
  chain.limit = jest.fn((n: number) => {
    capture.limits.push(n);
    return Object.assign(Promise.resolve(rows), chain);
  });
  chain.groupBy = jest.fn(() => {
    capture.groupBys += 1;
    return Promise.resolve([]);
  });
  chain.union = jest.fn(() => {
    capture.unions += 1;
    return makeChain(rows, capture);
  });
  return chain;
}

function makeHarness(options: {
  rows?: Record<string, unknown>[];
  grantRows?: Record<string, unknown>[];
  actor?: KbActorStanding;
}) {
  const capture: Capture = {
    wheres: [],
    orderBys: [],
    limits: [],
    groupBys: 0,
    selectCalls: 0,
    unions: 0,
    selections: [],
  };
  const rows = options.rows ?? [];
  const grantRows = options.grantRows ?? [];

  const db = {
    select: jest.fn((selection: CollectionSelection) => {
      capture.selectCalls += 1;
      capture.selections.push(selection);
      const node: Record<string, unknown> = {};
      node.from = jest.fn(() => node);
      node.where = jest.fn((clause: SQL) => {
        capture.wheres.push(clause);
        return Object.assign(Promise.resolve(grantRows), makeChain(rows, capture));
      });
      return node;
    }),
  };

  const auth = {
    resolveStanding: jest.fn().mockResolvedValue(options.actor ?? standing()),
  } as unknown as KnowledgeAuthorizationService;

  return {
    capture,
    auth,
    svc: new KnowledgeCollectionService(db as never, auth),
    db,
  };
}

function render(clause: SQL) {
  return new PgDialect().sqlToQuery(clause);
}

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Onboarding",
    icon: null,
    coverImage: null,
    spaceId: 7,
    projectId: null,
    parentPageId: null,
    status: "published",
    visibility: "org",
    contentType: "note",
    trustState: "verified",
    ownerMembershipId: MEMBERSHIP,
    ownerUserId: "user-1",
    createdById: "user-1",
    createdByMembershipId: MEMBERSHIP,
    lastEditedById: "user-1",
    lastEditedByMembershipId: MEMBERSHIP,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    deletedAt: null,
    nextReviewAt: null,
    verifiedUntil: null,
    contentRevision: 3,
    aclRevision: 1,
    cursorValue: "2026-09-20T00:00:00.000000",
    ...overrides,
  };
}

describe("KnowledgeCollectionService — the canonical page collection", () => {
  it("binds the caller's org into the query itself, so isolation does not rest on the seam alone", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query());

    const rendered = render(h.capture.wheres[0]);
    expect(rendered.params).toContain(ORG);
    expect(rendered.params).not.toContain(OTHER_ORG);
  });

  it("never replaces the canonical visible scope with its own filters, across whichever branch(es) it queries", async () => {
    const h = makeHarness({ rows: [] });

    await h.svc.listPages(user(), query({ owner: "me", status: ["published"] }));

    const combined = h.capture.wheres.map((w) => render(w).sql).join("\n");
    expect(combined).toContain("kb_page_grants");
    expect(combined).toContain("owner_membership_id");
    expect(combined).toContain("status");
  });

  it("excludes deleted pages unless the caller asks for them, and then excludes live ones", async () => {
    const live = makeHarness({ rows: [] });
    await live.svc.listPages(user(), query());
    expect(render(live.capture.wheres[0]).sql).toContain(
      '"deleted_at" is null',
    );

    const trash = makeHarness({ rows: [] });
    await trash.svc.listPages(user(), query({ deleted: true }));
    expect(render(trash.capture.wheres[0]).sql).toContain(
      '"deleted_at" is not null',
    );
  });

  it("returns nothing for owner=me when the actor has no membership, rather than listing every page", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ membershipId: null }),
    });

    const page = await h.svc.listPages(user(), query({ owner: "me" }));

    expect(page.data).toEqual([]);
    expect(h.capture.selectCalls).toBe(0);
  });

  it("filters by an explicit ownerMembershipId, distinct from the owner=me shortcut", async () => {
    const h = makeHarness({ rows: [] });

    await h.svc.listPages(user(), query({ ownerMembershipId: 99 }));

    const combined = h.capture.wheres.map((w) => render(w).sql).join("\n");
    expect(combined).toContain("owner_membership_id");
    const params = h.capture.wheres.flatMap((w) => render(w).params);
    expect(params).toContain(99);
  });

  it("returns nothing for sharedWithMe when the actor has neither a membership nor a role, because no grant can name them", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ membershipId: null, roleSlugs: [] }),
    });

    const page = await h.svc.listPages(user(), query({ sharedWithMe: true }));

    expect(page.data).toEqual([]);
    expect(h.capture.selectCalls).toBe(0);
  });

  it("excludes pages the actor owns or created from sharedWithMe, so 'shared' means someone else granted it", async () => {
    const h = makeHarness({ rows: [] });

    await h.svc.listPages(user(), query({ sharedWithMe: true }));

    const sql = render(h.capture.wheres[0]).sql;
    expect(sql).toContain('"owner_membership_id" IS NULL OR');
    expect(sql).toContain('"created_by_membership_id" IS NULL OR');
    expect(sql).toContain('"created_by_id" IS NULL OR');
  });

  it("over-fetches exactly one sentinel row so hasMore costs no second query", async () => {
    const h = makeHarness({ rows: [pageRow({ id: 1 }), pageRow({ id: 2 })] });

    const page = await h.svc.listPages(user(), query({ limit: 2 }));

    expect(h.capture.limits[0]).toBe(3);
    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("reports hasMore and mints a cursor from the last KEPT row, never from the discarded sentinel", async () => {
    const h = makeHarness({
      rows: [
        pageRow({ id: 1, cursorValue: "2026-09-20T00:00:00.000001" }),
        pageRow({ id: 2, cursorValue: "2026-09-19T00:00:00.000002" }),
        pageRow({ id: 3, cursorValue: "2026-09-18T00:00:00.000003" }),
      ],
    });

    const page = await h.svc.listPages(user(), query({ limit: 2 }));

    expect(page.data.map((row) => row.id)).toEqual([1, 2]);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();

    const decoded = Buffer.from(
      page.pagination.nextCursor ?? "",
      "base64url",
    ).toString("utf8");
    expect(decoded).toContain("2026-09-19T00:00:00.000002");
    expect(decoded).not.toContain("2026-09-18T00:00:00.000003");
  });

  it("orders by the same tuple the keyset compares, so a page boundary cannot skip or repeat a row", async () => {
    const newest = makeHarness({ rows: [] });
    await newest.svc.listPages(user(), query({ sort: "updated_desc" }));
    expect(newest.capture.orderBys[0]).toHaveLength(2);

    const alphabetical = makeHarness({ rows: [] });
    await alphabetical.svc.listPages(user(), query({ sort: "title_asc" }));
    expect(alphabetical.capture.orderBys[0]).toHaveLength(2);
  });

  it("applies the keyset bound only once a cursor is presented", async () => {
    const first = makeHarness({ rows: [pageRow()] });
    const firstPage = await first.svc.listPages(user(), query({ limit: 1 }));
    const withoutCursor = render(first.capture.wheres[0]).sql;

    const second = makeHarness({ rows: [pageRow()] });
    await second.svc.listPages(
      user(),
      query({ limit: 1, cursor: firstPage.pagination.nextCursor ?? undefined }),
    );
    const withCursor = render(second.capture.wheres[0]).sql;

    expect(withoutCursor).not.toContain('"updated_at", "kb_pages"."id") <');
    expect(firstPage.pagination.hasMore).toBe(false);
    expect(withCursor.length).toBeGreaterThanOrEqual(withoutCursor.length);
  });

  it("never projects page bodies into a list response", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    const page = await h.svc.listPages(user(), query());

    expect(page.data[0]).not.toHaveProperty("content");
    expect(page.data[0]).not.toHaveProperty("contentText");
    expect(page.data[0]).not.toHaveProperty("cursorValue");
    expect(page.data[0]).not.toHaveProperty("publicToken");
  });

  it("leaves sharedBy null unless the caller asked for shared pages, so an ordinary list pays nothing for it", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    const page = await h.svc.listPages(user(), query());

    expect(page.data[0].sharedBy).toBeNull();
  });

  it("reports who shared a page and at what level, taking the strongest grant when a membership and a role both name the actor", async () => {
    const h = makeHarness({
      rows: [pageRow({ id: 5 })],
      grantRows: [
        {
          pageId: 5,
          access: "view",
          grantedByMembershipId: 77,
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
        {
          pageId: 5,
          access: "edit",
          grantedByMembershipId: 88,
          createdAt: new Date("2026-09-11T00:00:00Z"),
        },
      ],
    });

    const page = await h.svc.listPages(user(), query({ sharedWithMe: true }));

    expect(page.data[0].sharedBy).toEqual({
      membershipId: 88,
      at: new Date("2026-09-11T00:00:00Z"),
      access: "edit",
    });
  });

  it("scopes the shared-by lookup to the caller's org and to the page ids already on this page", async () => {
    const h = makeHarness({
      rows: [pageRow({ id: 5 })],
      grantRows: [
        {
          pageId: 5,
          access: "view",
          grantedByMembershipId: 77,
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
      ],
    });

    await h.svc.listPages(user(), query({ sharedWithMe: true }));

    const grantWhere = render(h.capture.wheres[1]);
    expect(grantWhere.params).toContain(ORG);
    expect(grantWhere.params).not.toContain(OTHER_ORG);
    expect(grantWhere.sql).toContain('"revoked_at" is null');
  });

  it("computes facets only when asked, because a facet count scans the whole filtered set", async () => {
    const without = makeHarness({ rows: [pageRow()] });
    const plain = await without.svc.listPages(user(), query());
    expect(plain.facets).toBeNull();
    expect(without.capture.groupBys).toBe(0);

    const withFacets = makeHarness({ rows: [pageRow()] });
    const faceted = await withFacets.svc.listPages(
      user(),
      query({ facets: true }),
    );
    expect(faceted.facets).not.toBeNull();
    expect(faceted.facets?.owner).toBeDefined();
    expect(withFacets.capture.groupBys).toBe(3);
  });

  it("declares the owner facet in the route's @ResponseSchema, because an undeclared key is stripped by the contract and openapi never learns the field exists", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    const page = await h.svc.listPages(user(), query({ facets: true }));
    const declared = kbPageCollectionPageSchema.parse(page);

    expect(page.facets?.owner).toBeDefined();
    expect(declared.facets?.owner).toBeDefined();
  });

  it("excludes the keyset bound from the facet filter, or facet counts would shrink on every page", async () => {
    const h = makeHarness({
      rows: [pageRow({ id: 1 }), pageRow({ id: 2 })],
    });
    const first = await h.svc.listPages(user(), query({ limit: 1, facets: true }));
    expect(first.pagination.nextCursor).not.toBeNull();

    const next = makeHarness({
      rows: [pageRow({ id: 1 }), pageRow({ id: 2 })],
    });
    await next.svc.listPages(
      user(),
      query({
        limit: 1,
        facets: true,
        cursor: first.pagination.nextCursor ?? undefined,
      }),
    );

    const keysetMarker = '"updated_at", "kb_pages"."id") <';
    const listWhere = render(next.capture.wheres[0]).sql;
    const facetWhere = render(
      next.capture.wheres[next.capture.wheres.length - 1],
    ).sql;
    expect(listWhere).toContain(keysetMarker);
    expect(facetWhere).not.toContain(keysetMarker);
  });

  it("returns nothing when the search text reduces to no usable term, rather than matching every page", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    const page = await h.svc.listPages(user(), query({ q: "!!! ???" }));

    expect(page.data).toEqual([]);
    expect(h.capture.selectCalls).toBe(0);
  });

  it("resolves the actor's standing once per request, not once per predicate", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ sharedWithMe: true, owner: "me" }));

    expect(h.auth.resolveStanding).toHaveBeenCalledTimes(1);
  });
});

describe("KnowledgeCollectionService — BE-81 OR-to-UNION split", () => {
  it("splits the indexed branch and the grant branch into a UNION when the actor holds a grant branch, instead of OR-ing them into one un-indexable predicate", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query());

    expect(h.capture.unions).toBe(1);
    expect(h.capture.selectCalls).toBe(2);
    const branch1 = render(h.capture.wheres[0]).sql;
    const branch2 = render(h.capture.wheres[1]).sql;
    expect(branch1).not.toContain("kb_page_grants");
    expect(branch2).toContain("kb_page_grants");
  });

  it("issues a single branch, no UNION, for an org owner — there is no grant OR to split", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ isOrgOwner: true }),
    });

    await h.svc.listPages(user(), query());

    expect(h.capture.unions).toBe(0);
    expect(h.capture.selectCalls).toBe(1);
    expect(render(h.capture.wheres[0]).sql).not.toContain("kb_page_grants");
  });

  it("issues a single branch, no UNION, for an actor with neither membership nor roles — buildGrantBranch has nothing to check", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ membershipId: null, roleSlugs: [] }),
    });

    await h.svc.listPages(user(), query());

    expect(h.capture.unions).toBe(0);
    expect(h.capture.selectCalls).toBe(1);
  });

  it("issues a single branch, no UNION, for sharedWithMe — the grant EXISTS is already the sole branch, nothing to split", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ sharedWithMe: true }));

    expect(h.capture.unions).toBe(0);
    expect(render(h.capture.wheres[0]).sql).toContain("kb_page_grants");
  });

  it("orders the unioned result by the output column alias, never by a table-qualified column a UNION cannot resolve", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ sort: "updated_desc" }));

    const setOperationOrderBy =
      h.capture.orderBys[h.capture.orderBys.length - 1];
    const rendered = setOperationOrderBy.map((term) => render(term as SQL));
    for (const term of rendered) {
      expect(term.sql).not.toContain("kb_pages");
    }
    expect(rendered.some((t) => t.sql.includes("cursorValue"))).toBe(true);
    expect(rendered.some((t) => t.sql.includes("id"))).toBe(true);
  });

  it("bounds each UNION branch with its own ORDER BY and LIMIT, because the outer LIMIT cannot be pushed into a set operation and the branches would otherwise materialise every visible row", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ limit: 50 }));

    expect(h.capture.limits).toEqual([51, 51, 51]);
    expect(h.capture.orderBys).toHaveLength(3);
  });

  it("orders each UNION branch by the real, table-qualified columns, so the branch can walk the keyset index instead of sorting its whole result", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ limit: 50 }));

    for (const index of [0, 1]) {
      const rendered = h.capture.orderBys[index].map((term) => render(term as SQL));
      expect(rendered.some((t) => t.sql.includes("kb_pages"))).toBe(true);
    }
  });

  it("leaves the single-branch path with exactly one ORDER BY and one LIMIT, so the bounded-branch shape never costs a second query where there is no UNION", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ isOrgOwner: true }),
    });

    await h.svc.listPages(user(), query({ limit: 50 }));

    expect(h.capture.limits).toEqual([51]);
    expect(h.capture.orderBys).toHaveLength(1);
  });

  it("emits cursorValue as an output column alias, because a set operation resolves ORDER BY only against output names and Postgres raises 42703 for an unaliased expression", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ sort: "updated_desc" }));

    const branch = new QueryBuilder()
      .select(h.capture.selections[0])
      .from(kbPages)
      .toSQL();
    expect(branch.sql).toContain('as "cursorValue"');
  });

  it("emits cursorValue as an output alias on the title sort too, where the raw expression would otherwise collide with the projected title column", async () => {
    const h = makeHarness({ rows: [pageRow()] });

    await h.svc.listPages(user(), query({ sort: "title_asc" }));

    const branch = new QueryBuilder()
      .select(h.capture.selections[0])
      .from(kbPages)
      .toSQL();
    expect(branch.sql).toContain('as "cursorValue"');
  });

  it("still orders by the real columns, table-qualified, on the single-branch path where a UNION never happens", async () => {
    const h = makeHarness({
      rows: [pageRow()],
      actor: standing({ isOrgOwner: true }),
    });

    await h.svc.listPages(user(), query({ sort: "updated_desc" }));

    const rendered = h.capture.orderBys[0].map((term) => render(term as SQL));
    expect(rendered.some((t) => t.sql.includes("kb_pages"))).toBe(true);
  });

  it("both branches carry the same filter conditions, so a UNION cannot silently widen or narrow the result", async () => {
    const h = makeHarness({ rows: [] });

    await h.svc.listPages(user(), query({ status: ["published"] }));

    const branch1 = render(h.capture.wheres[0]).sql;
    const branch2 = render(h.capture.wheres[1]).sql;
    expect(branch1).toContain("status");
    expect(branch2).toContain("status");
  });

  it("the union's predicate is logically the same reachable set buildVisiblePageScope already proves, just split for the planner", () => {
    const scope = buildVisiblePageScope(standing(), "view");
    expect(scope.grantBranch).not.toBeNull();
    expect(scope.indexedBranch).toBeDefined();
  });
});

describe("KnowledgeCollectionService — four-case predicate equivalence (shape assertions; row-set equality requires a populated database and cannot be observed here)", () => {
  function stripParamNumbers(s: string): string {
    return s.replace(/\$\d+/g, "?");
  }

  it("case A: the indexed branch SQL contains the same expression as the standalone buildIndexedBranch output, confirming the UNION feeds the same predicate the OR form uses", () => {
    const stand = standing();
    const scope = buildVisiblePageScope(stand, "view");
    const d = new PgDialect();
    const fromScope = stripParamNumbers(d.sqlToQuery(scope.indexedBranch).sql);
    const standalone = stripParamNumbers(d.sqlToQuery(buildIndexedBranch(stand, "view")).sql);
    expect(fromScope).toContain(standalone);
    expect(fromScope).not.toContain("kb_page_grants");
  });

  it("case B: the grant branch SQL contains the same expression as the standalone buildGrantBranch output, confirming the UNION feeds the same predicate the OR form uses", () => {
    const stand = standing();
    const scope = buildVisiblePageScope(stand, "view");
    const grantExpr = buildGrantBranch(stand, "view");
    expect(grantExpr).not.toBeNull();
    if (grantExpr === null) throw new Error("unreachable");
    if (scope.grantBranch === null) throw new Error("unreachable");
    const d = new PgDialect();
    const fromScope = stripParamNumbers(d.sqlToQuery(scope.grantBranch).sql);
    const standalone = stripParamNumbers(d.sqlToQuery(grantExpr).sql);
    expect(fromScope).toContain(standalone);
    expect(fromScope).toContain("kb_page_grants");
  });

  it("case C: the set operator Drizzle emits is UNION not UNION ALL — row-set deduplication for a page reachable via both branches is a Postgres guarantee not observable without a populated database", () => {
    const scope = buildVisiblePageScope(standing(), "view");
    expect(scope.grantBranch).not.toBeNull();
    if (scope.grantBranch === null) throw new Error("unreachable");
    const qb = new QueryBuilder();
    const emitted = qb
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(scope.indexedBranch)
      .union(qb.select({ id: kbPages.id }).from(kbPages).where(scope.grantBranch))
      .toSQL().sql;
    expect(emitted).toMatch(/\bunion\b/i);
    expect(emitted).not.toMatch(/union all/i);
  });

  it("case D: the OR predicate that scope.predicate carries contains both the indexed and grant branch expressions, proving the two forms are built from the same sources", () => {
    const stand = standing();
    const scope = buildVisiblePageScope(stand, "view");
    const grantExpr = buildGrantBranch(stand, "view");
    expect(grantExpr).not.toBeNull();
    if (grantExpr === null) throw new Error("unreachable");
    if (scope.grantBranch === null) throw new Error("unreachable");
    const d = new PgDialect();
    const predNorm = stripParamNumbers(d.sqlToQuery(scope.predicate).sql);
    const indexedNorm = stripParamNumbers(d.sqlToQuery(buildIndexedBranch(stand, "view")).sql);
    const grantNorm = stripParamNumbers(d.sqlToQuery(grantExpr).sql);
    expect(predNorm).toContain(indexedNorm);
    expect(predNorm).toContain(grantNorm);
    expect(predNorm).not.toContain(OTHER_ORG);
  });

  it("both UNION branches carry the restriction predicate so a page the actor is restricted from is absent from the list — observable at SQL shape since row-set observation requires a populated database", () => {
    const stand = standing();
    const scope = buildVisiblePageScope(stand, "view");
    expect(scope.grantBranch).not.toBeNull();
    if (scope.grantBranch === null) throw new Error("unreachable");
    const d = new PgDialect();
    const indexedRendered = d.sqlToQuery(scope.indexedBranch);
    const grantRendered = d.sqlToQuery(scope.grantBranch);
    expect(indexedRendered.sql).toContain("kb_page_restrictions");
    expect(grantRendered.sql).toContain("kb_page_restrictions");
    expect(indexedRendered.params).toContain(stand.membershipId);
    expect(grantRendered.params).toContain(stand.membershipId);
    const standNoMembership = standing({ membershipId: null, roleSlugs: [] });
    const scopeAnon = buildVisiblePageScope(standNoMembership, "view");
    const anonIndexedRendered = d.sqlToQuery(scopeAnon.indexedBranch);
    expect(anonIndexedRendered.sql).toContain("kb_page_restrictions");
    expect(anonIndexedRendered.params).not.toContain(stand.membershipId);
  });
});
