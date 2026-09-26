import {
  bulkSubmissionsSchema,
  listSubmissionsQuerySchema,
} from "./feedbucket.schemas";

describe("listSubmissionsQuerySchema — filter parameter coverage", () => {
  const BASE = { page: "1", limit: "20" };

  describe("existing parameters stay valid after adding new fields", () => {
    it("accepts a baseline query with page and limit only", () => {
      const result = listSubmissionsQuerySchema.safeParse(BASE);
      expect(result.success).toBe(true);
    });

    it("accepts assigneeId as the canonical owner filter name (not ownerId)", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, assigneeId: "user-abc" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.assigneeId).toBe("user-abc");
    });

    it("rejects ownerId because it is not a declared field and the schema is strict", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, ownerId: "user-abc" });
      expect(result.success).toBe(false);
    });

    it("accepts search as the canonical text-filter name (not q)", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, search: "hello" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.search).toBe("hello");
    });

    it("rejects q because it is not a declared field and the schema is strict", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, q: "hello" });
      expect(result.success).toBe(false);
    });
  });

  describe("linked filter — tri-state", () => {
    it("accepts linked=linked and parses the value", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, linked: "linked" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.linked).toBe("linked");
    });

    it("accepts linked=unlinked and parses the value", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, linked: "unlinked" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.linked).toBe("unlinked");
    });

    it("defaults linked to undefined when the param is absent so all submissions are returned", () => {
      const result = listSubmissionsQuerySchema.safeParse(BASE);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.linked).toBeUndefined();
    });

    it("rejects an arbitrary string for linked so the server cannot silently misinterpret a typo", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, linked: "true" });
      expect(result.success).toBe(false);
    });
  });

  describe("from / to date range", () => {
    const FROM = "2026-01-01T00:00:00Z";
    const TO = "2026-06-01T00:00:00Z";

    it("accepts a valid from datetime", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, from: FROM });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.from).toBe(FROM);
    });

    it("accepts a valid to datetime", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, to: TO });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.to).toBe(TO);
    });

    it("accepts from and to when from is strictly before to", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, from: FROM, to: TO });
      expect(result.success).toBe(true);
    });

    it("rejects from and to when from equals to so an empty window is surfaced immediately", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, from: FROM, to: FROM });
      expect(result.success).toBe(false);
    });

    it("rejects from and to when from is after to so an inverted range is caught before hitting the DB", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, from: TO, to: FROM });
      expect(result.success).toBe(false);
    });

    it("rejects a non-datetime string for from so a bare date like '2026-01-01' does not reach the DB", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, from: "2026-01-01" });
      expect(result.success).toBe(false);
    });

    it("defaults from and to to undefined when neither param is present", () => {
      const result = listSubmissionsQuerySchema.safeParse(BASE);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.from).toBeUndefined();
        expect(result.data.to).toBeUndefined();
      }
    });
  });

  describe("duplicate filter — computed predicate, no migration required", () => {
    it("accepts duplicate=true so callers can filter to submissions that share a title", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, duplicate: "true" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.duplicate).toBe("true");
    });

    it("accepts duplicate=false so callers can filter out known-duplicate titles", () => {
      const result = listSubmissionsQuerySchema.safeParse({ ...BASE, duplicate: "false" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.duplicate).toBe("false");
    });

    it("leaves duplicate undefined when absent so the first page is served without duplication filtering", () => {
      const result = listSubmissionsQuerySchema.safeParse(BASE);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.duplicate).toBeUndefined();
    });
  });
});

describe("listSubmissionsQuerySchema — keyset cursor parameter", () => {
  const BASE = { page: "1", limit: "20" };

  it("accepts a cursor so a keyset page can be requested", () => {
    const result = listSubmissionsQuerySchema.safeParse({ ...BASE, cursor: "Y3Vyc29y" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe("Y3Vyc29y");
  });

  it("leaves cursor undefined when absent so the first page is served without one", () => {
    const result = listSubmissionsQuerySchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeUndefined();
  });

  it("rejects an empty cursor so a blank query string cannot mean 'page one' by accident", () => {
    const result = listSubmissionsQuerySchema.safeParse({ ...BASE, cursor: "" });
    expect(result.success).toBe(false);
  });

  it("clamps limit to the platform cap rather than rejecting an over-large keyset page", () => {
    const result = listSubmissionsQuerySchema.safeParse({ ...BASE, limit: "5000" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100);
  });
});

describe("listSubmissionsQuerySchema — combined filter round-trips", () => {
  it("parses all implemented filters together without conflict", () => {
    const result = listSubmissionsQuerySchema.safeParse({
      page: "1",
      limit: "50",
      widgetId: "7",
      type: "bug",
      status: "open",
      assigneeId: "user-xyz",
      search: "crash",
      linked: "unlinked",
      from: "2026-01-01T00:00:00Z",
      to: "2026-06-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.widgetId).toBe(7);
      expect(result.data.linked).toBe("unlinked");
      expect(result.data.from).toBe("2026-01-01T00:00:00Z");
      expect(result.data.to).toBe("2026-06-01T00:00:00Z");
    }
  });
});

describe("bulkSubmissionsSchema — bounded, strict, and filter-aware", () => {
  const STATUS_ACTION = { type: "status", status: "resolved" } as const;

  function idsOfLength(length: number): number[] {
    return Array.from({ length }, (_, index) => index + 1);
  }

  it("accepts exactly 100 ids because that is the documented bulk ceiling", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: idsOfLength(100),
      action: STATUS_ACTION,
    });
    expect(result.success).toBe(true);
  });

  it("rejects 101 ids so an unbounded bulk can never reach the database", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: idsOfLength(101),
      action: STATUS_ACTION,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty id array so a no-op bulk is a 400 and not a silent success", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [],
      action: STATUS_ACTION,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action type so a typo cannot be interpreted as a different action", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1],
      action: { type: "archive" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an assign action with a null assignee so bulk unassign is expressible", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1],
      action: { type: "assign", assigneeId: null },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the same filter vocabulary the list endpoint accepts so bulk targets the list predicate", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1, 2],
      action: STATUS_ACTION,
      filters: {
        widgetId: 7,
        type: "bug",
        status: "open",
        assigneeId: "user-xyz",
        search: "crash",
        linked: "unlinked",
        from: "2026-01-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a filter key the list endpoint does not serve so bulk cannot drift from list", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1],
      action: STATUS_ACTION,
      filters: { ownerId: "user-xyz" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an inverted date window in filters with the same rule the list query applies", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1],
      action: STATUS_ACTION,
      filters: { from: "2026-06-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a client-supplied orgId because tenancy is never taken from the body", () => {
    const result = bulkSubmissionsSchema.safeParse({
      submissionIds: [1],
      action: STATUS_ACTION,
      orgId: "org-attacker",
    });
    expect(result.success).toBe(false);
  });
});
