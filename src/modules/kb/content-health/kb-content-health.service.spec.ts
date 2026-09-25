import { NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbContentHealthService } from "./kb-content-health.service";
import type { ContentHealthSignalsQuery, DismissHealthItemBody } from "./dto/kb-content-health.schemas";

function makeChain(rows: unknown[] = []): object {
  const limit = jest.fn().mockImplementation(() => Promise.resolve(rows));
  const from = jest.fn();
  const where = jest.fn();
  const orderBy = jest.fn();
  const chain = Object.assign(Promise.resolve(rows), { from, where, orderBy, limit, select: jest.fn() });
  from.mockReturnValue(chain);
  where.mockReturnValue(chain);
  orderBy.mockReturnValue(chain);
  return chain;
}

function makeDb(rows: unknown[] = [], countRows: unknown[] = []): Db {
  let callCount = 0;
  const chain = makeChain(rows);
  const countChain = makeChain(countRows);

  return {
    select: jest.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? chain : countChain;
    }),
  } as unknown as Db;
}

function makeCapturingDb(rows: unknown[] = []): { db: Db; wheres: unknown[] } {
  const wheres: unknown[] = [];
  const limit = jest.fn().mockResolvedValue(rows);
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = limit;
  chain.where = jest.fn((clause: unknown) => {
    wheres.push(clause);
    return chain;
  });
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return { db, wheres };
}

function makeOrderCapturingDb(rows: unknown[] = []): { db: Db; orderBys: unknown[] } {
  const orderBys: unknown[] = [];
  const limit = jest.fn().mockResolvedValue(rows);
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = limit;
  chain.orderBy = jest.fn((...args: unknown[]) => {
    orderBys.push(...args);
    return chain;
  });
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return { db, orderBys };
}

function makeDismissDb(options: {
  pageVisible?: boolean;
  existingOpenItemUpdated?: boolean;
  insertedItem?: Record<string, unknown>;
}): Db {
  const { pageVisible = true, existingOpenItemUpdated = false, insertedItem } = options;

  const pageRow = { id: 1 };
  const dismissedRow = insertedItem ?? {
    id: 99,
    orgId: "org-1",
    pageId: 1,
    kind: "unowned",
    ruleVersion: 1,
    state: "dismissed",
    dismissedAt: new Date(),
    dismissedReason: "intentionally unowned",
    dismissalExpiresAt: null,
    impact: 0,
    evidence: {},
    detectedAt: new Date(),
    resolvedAt: null,
    assigneeMembershipId: null,
    dueAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const selectChain: Record<string, jest.Mock> = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => Promise.resolve(pageVisible ? [pageRow] : []));

  const updateReturning = jest.fn().mockResolvedValue(existingOpenItemUpdated ? [dismissedRow] : []);
  const updateWhere = jest.fn(() => ({ returning: updateReturning }));
  const updateSet = jest.fn(() => ({ where: updateWhere }));
  const updateChain = { set: updateSet };

  const insertReturning = jest.fn().mockResolvedValue([dismissedRow]);
  const insertValues = jest.fn(() => ({ returning: insertReturning }));
  const insertChain = { values: insertValues };

  return {
    select: jest.fn(() => selectChain),
    update: jest.fn(() => updateChain),
    insert: jest.fn(() => insertChain),
  } as unknown as Db;
}

function renderedWhere(wheres: unknown[]): string {
  const dialect = new PgDialect();
  return wheres
    .map((clause) => {
      if (!clause || typeof clause !== "object") return "";
      try {
        return dialect.sqlToQuery(clause as SQL).sql;
      } catch {
        return "";
      }
    })
    .join(" ");
}

function renderedOrderBy(orderBys: unknown[]): string {
  const dialect = new PgDialect();
  return orderBys
    .map((o) => {
      if (!o || typeof o !== "object") return String(o);
      try {
        return dialect.sqlToQuery(o as SQL).sql;
      } catch {
        return String(o);
      }
    })
    .join(" ");
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", principal: { kind: "human-session", membershipId: 1 } } as never;
}

function makeQuery(signalType: ContentHealthSignalsQuery["signalType"]): ContentHealthSignalsQuery {
  return { signalType, limit: 10, afterId: undefined, spaceId: undefined, ownerMembershipId: undefined };
}

const PAGE_ROW = {
  id: 1,
  title: "Page One",
  spaceId: null,
  status: "published",
  ownerMembershipId: null,
  updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  nextReviewAt: null,
  impact: 0,
};

describe("KbContentHealthService — signals", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns an empty page for unowned signal with no matching rows", async () => {
    const db = makeDb([]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("unowned"));
    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("returns paginated items for stale signal", async () => {
    const db = makeDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("stale"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(1);
  });

  it("emits a nextCursor when sentinel row present", async () => {
    const sentinel = { ...PAGE_ROW, id: 2 };
    const db = makeDb([PAGE_ROW, sentinel]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), { ...makeQuery("unverified"), limit: 1 });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(PAGE_ROW.id);
  });

  it("orders by computed impact score descending then id ascending, not by insertion order, so the highest-impact item reaches the caller first", async () => {
    const { db, orderBys } = makeOrderCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), makeQuery("stale"));
    const rendered = renderedOrderBy(orderBys);
    expect(rendered.toLowerCase()).toContain("least");
    expect(rendered.toUpperCase()).toContain("DESC");
  });

  it("projects impact as a column in the result, so callers can surface it without recomputing", async () => {
    const db = makeDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("unowned"));
    expect(typeof result.data[0]?.impact).toBe("number");
  });

  it("filters by ownerMembershipId when provided, so the caller can narrow to a specific page owner", async () => {
    const { db, wheres } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), { ...makeQuery("unowned"), ownerMembershipId: 7 });
    const rendered = renderedWhere(wheres);
    expect(rendered).toContain("owner_membership_id");
  });

  it("returns the page for an overdue_review signal when one matches, so the empty case below is not the only reachable outcome", async () => {
    const { db } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("overdue_review"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(PAGE_ROW.id);
  });

  it("returns nothing for an overdue_review signal when no review is overdue", async () => {
    const db = makeDb([]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("overdue_review"));
    expect(result.data).toHaveLength(0);
  });

  it("asks the reviews table for the overdue_review signal, not merely any table that happens to be mocked", async () => {
    const { db, wheres } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), makeQuery("overdue_review"));
    expect(renderedWhere(wheres)).toContain("kb_page_reviews");
  });

  it("returns the page for a broken_link signal when one matches, so the empty case below is not the only reachable outcome", async () => {
    const { db } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("broken_link"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(PAGE_ROW.id);
  });

  it("returns nothing for a broken_link signal when every link resolves", async () => {
    const db = makeDb([]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("broken_link"));
    expect(result.data).toHaveLength(0);
  });

  it("asks the links table for the broken_link signal, not merely any table that happens to be mocked", async () => {
    const { db, wheres } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), makeQuery("broken_link"));
    expect(renderedWhere(wheres)).toContain("kb_page_links");
  });

  it("returns the page for an overexposed signal when one matches, so the empty case is not the only reachable outcome", async () => {
    const { db } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("overexposed"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(PAGE_ROW.id);
  });

  it("references kb_spaces in the overexposed predicate to check is_public_help_center, not just the pages visibility column alone", async () => {
    const { db, wheres } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), makeQuery("overexposed"));
    const rendered = renderedWhere(wheres);
    expect(rendered).toContain("kb_spaces");
    expect(rendered).toContain("is_public_help_center");
  });

  it("returns the page for a duplicate_candidate signal when one matches, so the empty case is not the only reachable outcome", async () => {
    const { db } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.signals(makeUser(), makeQuery("duplicate_candidate"));
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe(PAGE_ROW.id);
  });

  it("self-joins kb_pages on content_text for the duplicate_candidate signal, so the join is not a vacuous always-true clause", async () => {
    const { db, wheres } = makeCapturingDb([PAGE_ROW]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), makeQuery("duplicate_candidate"));
    const rendered = renderedWhere(wheres);
    expect(rendered).toContain("content_text");
  });
});

describe("KbContentHealthService — counts", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns counts for all nine signal types including overexposed, duplicate_candidate and contradictory_claim", async () => {
    const countRow = { count: 3 };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([countRow]),
        }),
      }),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.counts(makeUser());
    expect(result.counts).toHaveLength(9);
    expect(result.counts.every((c) => c.count === 3)).toBe(true);
  });

  it("gives each of the nine counts a distinct signal type, so one predicate is not being counted nine times", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 3 }]),
        }),
      }),
    } as unknown as Db;

    const result = await new KbContentHealthService(db, auth as never).counts(
      makeUser(),
    );

    const types = result.counts.map((c) => c.signalType);
    expect(new Set(types).size).toBe(9);
  });

  it("builds a different predicate per signal, so the nine counts are not the same query repeated", async () => {
    const { db, wheres } = makeCapturingDb([{ count: 3 }]);
    const capturing = db as unknown as { select: jest.Mock };
    capturing.select = jest.fn(() => {
      const node: Record<string, jest.Mock> = {};
      node.from = jest.fn(() => node);
      node.where = jest.fn((clause: unknown) => {
        wheres.push(clause);
        return Promise.resolve([{ count: 3 }]);
      });
      return node;
    });

    await new KbContentHealthService(db, auth as never).counts(makeUser());

    const outer = wheres
      .map((w) => renderedWhere([w]))
      .filter((text) => text.includes('"kb_pages"."deleted_at" is null'));
    expect(outer).toHaveLength(9);
    expect(new Set(outer).size).toBeGreaterThanOrEqual(5);

    const everything = renderedWhere(wheres);
    expect(everything).toContain("kb_page_reviews");
    expect(everything).toContain("kb_page_links");
  });

  it("defaults count to zero when query returns no rows", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.counts(makeUser());
    expect(result.counts.every((c) => c.count === 0)).toBe(true);
  });
});

describe("KbContentHealthService — dismiss", () => {
  afterEach(() => jest.resetAllMocks());

  const dismissBody: DismissHealthItemBody = {
    pageId: 1,
    kind: "unowned",
    ruleVersion: 1,
    reason: "intentionally unowned, owned by space",
  };

  it("throws NotFoundException when the page is not visible to the caller, so a dismiss cannot be used to probe cross-tenant page existence", async () => {
    const db = makeDismissDb({ pageVisible: false });
    const svc = new KbContentHealthService(db, auth as never);
    await expect(svc.dismiss(makeUser(), dismissBody)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the dismissed health item when an open item is updated in-place, so repeated dismissals are idempotent rather than creating duplicate rows", async () => {
    const db = makeDismissDb({ pageVisible: true, existingOpenItemUpdated: true });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.dismiss(makeUser(), dismissBody);
    expect(result.state).toBe("dismissed");
    expect(result.dismissedReason).toBe("intentionally unowned");
  });

  it("creates a pre-emptive dismissed item when no open item exists, so a curator can suppress a signal before the detector runs", async () => {
    const db = makeDismissDb({ pageVisible: true, existingOpenItemUpdated: false });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.dismiss(makeUser(), dismissBody);
    expect(result.state).toBe("dismissed");
    const dbMock = db as unknown as { insert: jest.Mock };
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it("stores the dismissal expiry when provided, so the item reopens automatically rather than becoming a permanent suppression", async () => {
    const expiresAt = new Date("2027-06-01T00:00:00.000Z");
    const db = makeDismissDb({ pageVisible: true, existingOpenItemUpdated: false });
    const svc = new KbContentHealthService(db, auth as never);
    await svc.dismiss(makeUser(), { ...dismissBody, dismissalExpiresAt: expiresAt });
    const dbMock = db as unknown as { insert: jest.Mock };
    const insertValues = (dbMock.insert as jest.Mock).mock.results[0]?.value as { values: jest.Mock } | undefined;
    const calledWith: Record<string, unknown> = insertValues?.values.mock.calls[0]?.[0] as Record<string, unknown> ?? {};
    expect(calledWith["dismissalExpiresAt"]).toEqual(expiresAt);
  });
});
