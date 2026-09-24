import { and, eq, isNull, sql } from "drizzle-orm";
import { KbPageSearchQueryService } from "./kb-page-search-query.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const VISIBLE_PREDICATE = sql`kb_visible_scope_marker`;
const HIDDEN_PREDICATE = sql`false`;

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

function makeAuth(predicate = VISIBLE_PREDICATE) {
  return { visiblePagePredicate: jest.fn().mockResolvedValue(predicate) };
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

function makeCapturingDb(rows: unknown[] = []) {
  const whereClauses: unknown[] = [];
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
    db: {
      select: jest.fn().mockReturnValue(chain),
    },
  };
}

function makeService(db: unknown, auth: unknown): KbPageSearchQueryService {
  return new KbPageSearchQueryService(db as never, auth as never);
}

const baseQuery = { q: "onboarding", limit: 20, facets: false } as const;

describe("KbPageSearchQueryService — visibility", () => {
  it("binds the caller's org_id into the SQL predicate, not only through the auth seam", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth();

    await makeService(db, auth).search(makeUser({ orgId: "org-x" }), baseQuery);

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain("org-x");
  });

  it("uses the predicate returned by the canonical visibility seam, not one assembled inline", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth(VISIBLE_PREDICATE);

    await makeService(db, auth).search(makeUser(), baseQuery);

    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain(serialize(VISIBLE_PREDICATE));
  });

  it("asks the visibility seam for a view-level scope", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();
    const user = makeUser();

    await makeService(db, auth).search(user, baseQuery);

    expect(auth.visiblePagePredicate).toHaveBeenCalledWith(user, "view");
  });

  it("returns a page that is within the caller's visible scope", async () => {
    const row = {
      id: 7,
      title: "Onboarding guide",
      spaceId: null,
      projectId: null,
      status: "published",
      trustState: "verified",
      visibility: "org",
      contentType: "note",
      updatedAt: new Date(),
      snippet: "Onboarding starts here",
    };
    const { db } = makeCapturingDb([row]);
    const auth = makeAuth(VISIBLE_PREDICATE);

    const result = await makeService(db, auth).search(makeUser(), baseQuery);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(7);
  });

  it("a page outside the caller's visible scope never appears in items or in any snippet", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth(HIDDEN_PREDICATE);

    const result = await makeService(db, auth).search(makeUser(), baseQuery);

    expect(result.items).toHaveLength(0);
    const combined = whereClauses.map(serialize).join("\n");
    expect(combined).toContain(serialize(HIDDEN_PREDICATE));
  });
});

describe("KbPageSearchQueryService — facet isolation", () => {
  it("facet queries carry the same visibility predicate as the item query", async () => {
    const { db, whereClauses } = makeCapturingDb([]);
    const auth = makeAuth(VISIBLE_PREDICATE);

    await makeService(db, auth).search(makeUser(), { ...baseQuery, facets: true });

    const combined = whereClauses.map(serialize).join("\n");
    const occurrences = combined.split(serialize(VISIBLE_PREDICATE)).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("facet counts are absent when the caller requests no facets", async () => {
    const { db } = makeCapturingDb([]);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, facets: false });

    expect(result.facets).toBeNull();
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
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      title: `Page ${i + 1}`,
      spaceId: null,
      projectId: null,
      status: "published",
      trustState: "unverified",
      visibility: "org",
      contentType: "note",
      updatedAt: new Date(),
      snippet: "snippet",
    }));
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(20);
    expect(result.limit).toBe(20);
  });

  it("reports hasMore: false when results fit within the limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      title: `Page ${i + 1}`,
      spaceId: null,
      projectId: null,
      status: "published",
      trustState: "unverified",
      visibility: "org",
      contentType: "note",
      updatedAt: new Date(),
      snippet: "snippet",
    }));
    const { db } = makeCapturingDb(rows);
    const auth = makeAuth();

    const result = await makeService(db, auth).search(makeUser(), { ...baseQuery, limit: 20 });

    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(5);
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
