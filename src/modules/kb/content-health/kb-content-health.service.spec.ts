import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbContentHealthService } from "./kb-content-health.service";
import type { ContentHealthSignalsQuery } from "./dto/kb-content-health.schemas";

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

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", principal: { kind: "human-session", membershipId: 1 } } as never;
}

function makeQuery(signalType: ContentHealthSignalsQuery["signalType"]): ContentHealthSignalsQuery {
  return { signalType, limit: 10, afterId: undefined, spaceId: undefined };
}

const PAGE_ROW = {
  id: 1,
  title: "Page One",
  spaceId: null,
  status: "published",
  ownerMembershipId: null,
  updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  nextReviewAt: null,
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
});

describe("KbContentHealthService — counts", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns counts for all six signal types", async () => {
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
    expect(result.counts).toHaveLength(6);
    expect(result.counts.every((c) => c.count === 3)).toBe(true);
  });

  it("gives each of the six counts a distinct signal type, so one predicate is not being counted six times", async () => {
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
    expect(new Set(types).size).toBe(6);
  });

  it("builds a different predicate per signal, so the six counts are not the same query repeated", async () => {
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
    expect(outer).toHaveLength(6);
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
