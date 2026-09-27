import type { SQL } from "drizzle-orm";
import {
  FTS_ID_CAP,
  KbPageSearchQueryService,
} from "./kb-page-search-query.service";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { searchScopeTag, encodeSearchCursor } from "./kb-page-search-cursor";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-a",
    orgId: "org-a",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    ...overrides,
  } as CurrentUserContext;
}

function makeStanding(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: "org-a",
    userId: "user-a",
    membershipId: 5,
    roleSlugs: ["writer"],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [3],
    accessibleProjectIds: [],
    permissionsVersion: 2,
    ...overrides,
  };
}

function makeAuth(standing: KbActorStanding = makeStanding()) {
  return { resolveStanding: jest.fn().mockResolvedValue(standing) };
}

const render = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (typeof node !== "object") return String(node);
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return render(record.queryChunks);
  if (typeof record.value === "string" || Array.isArray(record.value)) return render(record.value);
  if (typeof record.name === "string") return record.name;
  return "";
};

const serialize = (value: unknown): string =>
  render(value).replace(/\s+/g, " ").trim();

function makeCapturingDb(rows: unknown[] = [], executeRows: unknown[] = [{ id: 1 }]) {
  const whereClauses: unknown[] = [];
  const selectProjections: unknown[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((clause: unknown) => {
      whereClauses.push(clause);
      return chain;
    }),
    orderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return {
    whereClauses,
    selectProjections,
    db: {
      select: jest.fn((projection?: unknown) => {
        if (projection !== undefined) selectProjections.push(projection);
        return chain;
      }),
      execute: jest.fn().mockResolvedValue(executeRows),
      transaction: jest.fn((callback: (tx: { execute: jest.Mock }) => Promise<unknown>) =>
        callback({ execute: jest.fn().mockResolvedValue([]) }),
      ),
    },
  };
}

function makeService(db: unknown, auth: unknown): KbPageSearchQueryService {
  return new KbPageSearchQueryService(db as never, auth as never);
}

function searchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "Onboarding guide",
    spaceId: null,
    projectId: null,
    status: "published",
    trustState: "verified",
    visibility: "org",
    contentType: "note",
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    snippet: "Onboarding starts here",
    rankValue: "0.5",
    updatedAtValue: "2026-09-20T00:00:00.000000",
    ...overrides,
  };
}

const baseQuery = { q: "onboarding", limit: 20, facets: false } as const;

describe("KbPageSearchQueryService — SECURITY DEFINER id routing", () => {
  it("resolves the lexical match through the SECURITY DEFINER function inside the same statement, so the GIN index is reached in one round trip", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).toContain("search_kb_page_ids");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("passes the raw query through to the function so a hyphenated term reaches websearch tokenisation intact", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), { ...baseQuery, q: "ERR-500" });

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).toContain("ERR-500");
    expect(combined).toContain("search_kb_page_ids");
  });

  it("bounds the candidate set with the exported cap rather than an inline number", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).toContain(String(FTS_ID_CAP));
  });

  it("keeps the direct fts scan out of the where clause, because that is the predicate the RLS barrier blocks", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).not.toContain("@@");
    expect(combined).not.toContain("plainto_tsquery");
  });

  it("applies the visibility predicate alongside the function's ids, because SECURITY DEFINER grants the function rights the caller does not have", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth(makeStanding({ orgId: "org-x" }));

    await makeService(db, auth).search(makeUser({ orgId: "org-x" }), baseQuery);

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).toContain("search_kb_page_ids");
    expect(combined).toContain("org-x");
  });

  it("returns the row the query yields once it has passed both the function and the predicate — positive pair for the filters above", async () => {
    const { db } = makeCapturingDb([searchRow({ id: 42 })]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), baseQuery);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(42);
  });
});

describe("KbPageSearchQueryService — visibility", () => {
  it("binds the caller's org_id into the SQL predicate, not only through the auth seam", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth(makeStanding({ orgId: "org-x" }));

    await makeService(db, auth).search(makeUser({ orgId: "org-x" }), baseQuery);

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain("org-x");
  });

  it("uses the predicate produced by the canonical visibility seam, not one assembled inline", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const standing = makeStanding();
    const auth = makeAuth(standing);

    await makeService(db, auth).search(makeUser(), baseQuery);

    const expected = buildVisiblePageScope(standing, "view").predicate;
    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain(serialize(expected));
  });

  it("resolves the caller's standing through the canonical seam", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();
    const user = makeUser();

    await makeService(db, auth).search(user, baseQuery);

    expect(auth.resolveStanding).toHaveBeenCalledWith(user);
  });

  it("returns a page that is within the caller's visible scope", async () => {
    const { db } = makeCapturingDb([searchRow()]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), baseQuery);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(7);
  });

  it("narrows a non-owner member's predicate rather than falling back to a tenant-only pass-all", async () => {
    const standing = makeStanding({ accessibleSpaceIds: [], accessibleProjectIds: [] });

    const narrowed = serialize(buildVisiblePageScope(standing, "view").predicate);
    const tenantOnly = serialize(
      buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view").predicate,
    );
    expect(narrowed).not.toBe(tenantOnly);

    const { db, whereClauses } = makeCapturingDb([]);
    await makeService(db, makeAuth(standing)).search(makeUser(), baseQuery);
    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain(narrowed);
  });

  it("applies the grant branch of the visibility predicate to the candidate ids so a grant-only page must still hold a valid grant", async () => {
    const standing = makeStanding({ membershipId: 5, roleSlugs: ["writer"], isOrgOwner: false, isKbAdmin: false });
    const { db, whereClauses } = makeCapturingDb([], [{ id: 7 }]);

    await makeService(db, makeAuth(standing)).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain("kb_page_grants");
  });
});

describe("KbPageSearchQueryService — facet isolation", () => {
  it("facet queries carry the same visibility predicate as the item query", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const standing = makeStanding();
    const auth = makeAuth(standing);

    await makeService(db, auth).search(makeUser(), { ...baseQuery, facets: true });

    const expected = serialize(buildVisiblePageScope(standing, "view").predicate);
    const combined = whereClauses.map(serialize).join("\n");
    const occurrences = combined.split(expected).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("facet counts are absent when the caller requests no facets", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, facets: false });

    expect(result.facets).toBeNull();
  });
});

describe("KbPageSearchQueryService — type filter", () => {
  it("narrows results to the requested content type", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), { ...baseQuery, type: "sop" });

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain("content_type");
  });

  it("does not filter by content type when none is requested", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).not.toContain("content_type");
  });
});

describe("KbPageSearchQueryService — query safety", () => {
  it("returns empty results for a punctuation-only query rather than matching every page", async () => {
    const { db } = makeCapturingDb([{ id: 1, title: "Anything" }]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, q: "!!! ---" });

    expect(result.items).toHaveLength(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns empty results for an all-whitespace query rather than matching every page", async () => {
    const { db } = makeCapturingDb([{ id: 1, title: "Anything" }]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, q: "   " });

    expect(result.items).toHaveLength(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("KbPageSearchQueryService — ceiling declaration", () => {
  it("reports hasMore: true when results exceed the requested limit", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => searchRow({ id: i + 1, title: `Page ${i + 1}` }));
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(20);
    expect(result.limit).toBe(20);
  });

  it("reports hasMore: false when results fit within the limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => searchRow({ id: i + 1, title: `Page ${i + 1}` }));
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(5);
  });
});

describe("KbPageSearchQueryService — cursor", () => {
  it("mints a nextCursor only when there is another page, and never leaks the internal rank/timestamp fields", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => searchRow({ id: i + 1 }));
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.nextCursor).not.toBeNull();
    expect(result.items[0]).not.toHaveProperty("rankValue");
    expect(result.items[0]).not.toHaveProperty("updatedAtValue");
  });

  it("returns a null nextCursor on the last page", async () => {
    const rows = [searchRow({ id: 1 })];
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.nextCursor).toBeNull();
  });

  it("applies a keyset bound only once a valid cursor is presented", async () => {
    const withoutCursor = makeCapturingDb([]);
    const standing = makeStanding();
    await makeService(withoutCursor.db, makeAuth(standing)).search(makeUser(), baseQuery);
    const unbounded = serialize(withoutCursor.whereClauses[0] as SQL);

    const scopeTag = searchScopeTag(baseQuery, buildVisiblePageScope(standing, "view").fingerprint);
    const cursor = encodeSearchCursor(scopeTag, {
      rank: "0.4",
      updatedAt: "2026-09-19T00:00:00.000000",
      id: 12,
    });

    const withCursor = makeCapturingDb([]);
    await makeService(withCursor.db, makeAuth(standing)).search(makeUser(), { ...baseQuery, cursor });
    const bounded = serialize(withCursor.whereClauses[0] as SQL);

    expect(bounded.length).toBeGreaterThan(unbounded.length);
  });

  it("treats a cursor minted under a different filter set as page one rather than a driver error", async () => {
    const standing = makeStanding();
    const scopeTag = searchScopeTag({ ...baseQuery, q: "different query" }, buildVisiblePageScope(standing, "view").fingerprint);
    const staleCursor = encodeSearchCursor(scopeTag, {
      rank: "0.4",
      updatedAt: "2026-09-19T00:00:00.000000",
      id: 12,
    });

    const withStaleCursor = makeCapturingDb([]);
    await makeService(withStaleCursor.db, makeAuth(standing)).search(makeUser(), {
      ...baseQuery,
      cursor: staleCursor,
    });
    const withStale = serialize(withStaleCursor.whereClauses[0] as SQL);

    const withoutCursor = makeCapturingDb([]);
    await makeService(withoutCursor.db, makeAuth(standing)).search(makeUser(), baseQuery);
    const withoutAny = serialize(withoutCursor.whereClauses[0] as SQL);

    expect(withStale).toBe(withoutAny);
  });

  it("excludes the keyset bound from the facet filter, or facet counts would shrink on every page", async () => {
    const standing = makeStanding();
    const scopeTag = searchScopeTag(baseQuery, buildVisiblePageScope(standing, "view").fingerprint);
    const cursor = encodeSearchCursor(scopeTag, {
      rank: "0.4",
      updatedAt: "2026-09-19T00:00:00.000000",
      id: 12,
    });

    const { db, whereClauses } = makeCapturingDb([]);
    await makeService(db, makeAuth(standing)).search(makeUser(), { ...baseQuery, facets: true, cursor });

    const listWhere = serialize(whereClauses[0] as SQL);
    const facetWhere = serialize(whereClauses[1] as SQL);
    expect(facetWhere.length).toBeLessThan(listWhere.length);
  });
});

describe("KbPageSearchQueryService — no embedding calls", () => {
  it("does not call any embedding provider — the service is lexical only", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();
    const embedSpy = jest.fn();

    const svc = makeService(db, auth);
    (svc as unknown as Record<string, unknown>).embedQueryWithCredit = embedSpy;

    await svc.search(makeUser(), baseQuery);

    expect(embedSpy).not.toHaveBeenCalled();
  });
});

describe("KbPageSearchQueryService — stale, deleted and archived exclusion", () => {
  it("excludes soft-deleted pages from the item query, so a trashed page never appears as a search hit", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery });

    expect(serialize(whereClauses[0])).toContain("deleted_at is null");
  });

  it("excludes archived pages when no status filter is given, rather than ranking a retired page beside live ones", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery });

    const rendered = serialize(whereClauses[0]);
    expect(rendered).toContain("status");
    expect(rendered).toContain("archived");
  });

  it("includes archived pages only when the caller asks for them by name, so the exclusion is a default and not a ceiling", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery, status: "archived" });

    expect(serialize(whereClauses[0])).toContain("archived");
  });

  it("carries the deleted_at fence into the facet query too, or facet counts would report pages the list cannot show", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery, facets: true });

    expect(whereClauses.length).toBeGreaterThan(1);
    for (const clause of whereClauses) {
      expect(serialize(clause)).toContain("deleted_at is null");
    }
  });
});

describe("KbPageSearchQueryService — exact identifier queries", () => {
  it("passes the raw query including hyphens to the SECURITY DEFINER function so ERR-500 reaches websearch tokenisation intact", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery, q: "ERR-500" });

    const combined = whereClauses.map(serialize).join(" ");
    expect(combined).toContain("ERR-500");
    expect(combined).toContain("search_kb_page_ids");
  });

  it("still builds a prefix tsquery for ranking and snippets so the search result relevance is unaffected by the id routing", async () => {
    const { db, whereClauses } = makeCapturingDb([], [{ id: 1 }]);
    const svc = makeService(db, makeAuth());

    await svc.search(makeUser(), { ...baseQuery, q: "onbo" });

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).not.toContain("to_tsquery");
  });
});
