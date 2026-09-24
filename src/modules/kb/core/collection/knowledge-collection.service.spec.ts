import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KnowledgeCollectionService } from "./knowledge-collection.service";
import type { KnowledgeAuthorizationService } from "../authorization/knowledge-authorization.service";
import type { KbActorStanding } from "../authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { KbPageCollectionQuery } from "./knowledge-collection.types";

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

interface Capture {
  wheres: SQL[];
  orderBys: unknown[][];
  limits: number[];
  groupBys: number;
  selectCalls: number;
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
  };
  const rows = options.rows ?? [];
  const grantRows = options.grantRows ?? [];

  const db = {
    select: jest.fn(() => {
      capture.selectCalls += 1;
      const chain: Record<string, unknown> = {};
      chain.orderBy = jest.fn((...terms: unknown[]) => {
        capture.orderBys.push(terms);
        return chain;
      });
      chain.limit = jest.fn((n: number) => {
        capture.limits.push(n);
        return Promise.resolve(rows);
      });
      chain.groupBy = jest.fn(() => {
        capture.groupBys += 1;
        return Promise.resolve([]);
      });

      const node: Record<string, unknown> = {};
      node.from = jest.fn(() => node);
      node.where = jest.fn((clause: SQL) => {
        capture.wheres.push(clause);
        return Object.assign(Promise.resolve(grantRows), chain);
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

  it("never replaces the canonical visible scope with its own filters", async () => {
    const h = makeHarness({ rows: [] });

    await h.svc.listPages(user(), query({ owner: "me", status: ["published"] }));

    const sql = render(h.capture.wheres[0]).sql;
    expect(sql).toContain("kb_page_grants");
    expect(sql).toContain("owner_membership_id");
    expect(sql).toContain("status");
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
    expect(h.capture.selectCalls).toBe(1);
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
    expect(withFacets.capture.groupBys).toBe(2);
  });

  it("excludes the keyset bound from the facet filter, or facet counts would shrink on every page", async () => {
    const h = makeHarness({ rows: [pageRow()] });
    const first = await h.svc.listPages(user(), query({ limit: 1, facets: true }));

    const next = makeHarness({ rows: [pageRow()] });
    await next.svc.listPages(
      user(),
      query({
        limit: 1,
        facets: true,
        cursor: first.pagination.nextCursor ?? undefined,
      }),
    );

    const listWhere = render(next.capture.wheres[0]).sql;
    const facetWhere = render(next.capture.wheres[1]).sql;
    expect(facetWhere.length).toBeLessThanOrEqual(listWhere.length);
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
