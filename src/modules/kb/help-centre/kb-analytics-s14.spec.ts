import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { encodeTupleCursor } from "../../../common/pagination/cursor";
import { KbAnalyticsService } from "./kb-analytics.service";

const dialect = new PgDialect();

type Rendered = { sql: string; params: unknown[] };
const EMPTY: Rendered = { sql: "", params: [] };

function render(value: unknown): Rendered {
  if (!is(value, SQL)) return EMPTY;
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql, params: [...query.params] };
}

const auth = { visiblePagePredicate: jest.fn().mockResolvedValue(undefined) } as unknown as never;

const USER = { userId: "user-1", orgId: "org-1", isOrgOwner: false } as unknown as CurrentUserContext;

function eventGroupHarness(rows: Record<string, unknown>[] = []) {
  const havings: unknown[] = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          groupBy: jest.fn(() => ({
            having: jest.fn((clause: unknown) => {
              havings.push(clause);
              return {
                orderBy: jest.fn(() => ({
                  limit: jest.fn().mockResolvedValue(rows),
                })),
              };
            }),
          })),
        })),
      })),
    })),
  } as unknown as Db;
  return { db, havings };
}

describe("KbAnalyticsService — minimum-cohort privacy threshold", () => {
  it("gaps() floors the search-gap aggregate at a minimum cohort size", async () => {
    const { db, havings } = eventGroupHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.gaps("org-1", {});

    expect(havings).toHaveLength(1);
    const rendered = render(havings[0]);
    expect(rendered.sql).toContain("count(*) >=");
    expect(rendered.params).toContain(3);
  });

  it("noResults() floors the zero-result aggregate at a minimum cohort size", async () => {
    const { db, havings } = eventGroupHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.noResults("org-1", {});

    expect(havings).toHaveLength(1);
    const rendered = render(havings[0]);
    expect(rendered.sql).toContain("count(*) >=");
    expect(rendered.params).toContain(3);
  });

  it("contentGaps() floors the content-gap aggregate at a minimum cohort size", async () => {
    const { db, havings } = eventGroupHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.contentGaps("org-1", {});

    expect(havings).toHaveLength(1);
    const rendered = render(havings[0]);
    expect(rendered.sql).toContain("count(*) >=");
    expect(rendered.params).toContain(3);
  });
});

function overviewHarness() {
  const wheres: Rendered[] = [];
  const projections: Record<string, unknown>[] = [];
  const chain = () => ({
    orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
  });
  const db = {
    select: jest.fn((fields: Record<string, unknown>) => {
      projections.push(fields);
      return {
        from: jest.fn(() => ({
          where: jest.fn((clause: unknown) => {
            wheres.push(render(clause));
            return Object.assign(Promise.resolve([{}]), chain());
          }),
        })),
      };
    }),
  } as unknown as Db;
  return { db, wheres, projections };
}

describe("KbAnalyticsService.overview — space filter and public deflection", () => {
  it("scopes both kb_pages statistics queries to a given space", async () => {
    const { db, wheres } = overviewHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.overview("org-1", { spaceId: 42 });

    const pageWheres = wheres.filter((w) => w.sql.includes(`"kb_pages"`));
    expect(pageWheres.length).toBeGreaterThanOrEqual(2);
    for (const w of pageWheres) {
      expect(w.sql).toContain(`"kb_pages"."space_id"`);
      expect(w.params).toContain(42);
    }
  });

  it("does not scope kb_pages statistics by space when spaceId is omitted", async () => {
    const { db, wheres } = overviewHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.overview("org-1", {});

    const pageWheres = wheres.filter((w) => w.sql.includes(`"kb_pages"`));
    expect(pageWheres.length).toBeGreaterThanOrEqual(2);
    for (const w of pageWheres) {
      expect(w.sql).not.toContain(`"kb_pages"."space_id"`);
    }
  });

  it("projects a ticketsDeflected count filtered to the ticket_deflected event", async () => {
    const { db, projections } = overviewHarness();
    const svc = new KbAnalyticsService(db, auth);

    await svc.overview("org-1", {});

    const eventProjection = projections.find((p) => "ticketsDeflected" in p);
    expect(eventProjection).toBeDefined();
    const rendered = render(eventProjection?.ticketsDeflected);
    expect(rendered.sql.toLowerCase()).toContain("ticket_deflected");
  });
});

function pagesHarness(rows: Record<string, unknown>[] = []) {
  const havings: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    leftJoin: self,
    where: self,
    groupBy: self,
    having: jest.fn((clause: unknown) => {
      havings.push(clause);
      return chain;
    }),
    orderBy: self,
    limit: jest.fn().mockResolvedValue(rows),
  });
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return { db, havings };
}

describe("KbAnalyticsService.pages — cursor pagination", () => {
  it("issues no HAVING filter on the first page", async () => {
    const { db, havings } = pagesHarness([]);
    const svc = new KbAnalyticsService(db, auth);

    await svc.pages(USER, { limit: 50 });

    expect(havings).toHaveLength(1);
    expect(havings[0]).toBeUndefined();
  });

  it("decodes a tuple cursor into a (viewer count, id) keyset predicate", async () => {
    const { db, havings } = pagesHarness([]);
    const svc = new KbAnalyticsService(db, auth);
    const cursor = encodeTupleCursor(["7", "12"]);

    await svc.pages(USER, { limit: 50, cursor });

    expect(havings).toHaveLength(1);
    const rendered = render(havings[0]);
    expect(rendered.sql).toContain("<");
    expect(rendered.params).toEqual(expect.arrayContaining([7, 12]));
  });

  it("reports hasMore and a nextCursor when the sentinel row is present", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: 51 - i,
      title: `Page ${51 - i}`,
      status: "published",
      trustState: "verified",
      updatedAt: new Date(),
      uniqueViewers: 51 - i,
      commentCount: 0,
      versionCount: 1,
    }));
    const { db } = pagesHarness(rows);
    const svc = new KbAnalyticsService(db, auth);

    const page = await svc.pages(USER, { limit: 50 });

    expect(page.data).toHaveLength(50);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });
});

function reviewsHarness(decided: Record<string, unknown>, overdue: Record<string, unknown>) {
  const wheres: Rendered[] = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((clause: unknown) => {
          wheres.push(render(clause));
          const isOverdueQuery = wheres.length > 1 && !render(clause).sql.includes("!=");
          return Promise.resolve([isOverdueQuery ? overdue : decided]);
        }),
      })),
    })),
  } as unknown as Db;
  return { db, wheres };
}

describe("KbAnalyticsService.reviewSla", () => {
  it("computes the SLA hit rate from decided reviews", async () => {
    const { db } = reviewsHarness({ decided: 10, metSla: 7 }, { overdueOpen: 2 });
    const svc = new KbAnalyticsService(db, auth);

    const result = await svc.reviewSla("org-1", {});

    expect(result.decided).toBe(10);
    expect(result.metSla).toBe(7);
    expect(result.slaRate).toBeCloseTo(0.7);
    expect(result.overdueOpen).toBe(2);
  });

  it("does not divide by zero when nothing has been decided yet", async () => {
    const { db } = reviewsHarness({ decided: 0, metSla: 0 }, { overdueOpen: 0 });
    const svc = new KbAnalyticsService(db, auth);

    const result = await svc.reviewSla("org-1", {});

    expect(result.slaRate).toBe(0);
  });
});

describe("KbAnalyticsService.citationReuse", () => {
  it("floors reuse at more than one citation and reads both citation sources", async () => {
    const executed: unknown[] = [];
    const db = {
      execute: jest.fn((clause: unknown) => {
        executed.push(clause);
        return Promise.resolve([
          { kind: "page", ref_id: 4, title: "Refund policy", reuse_count: 3 },
        ]);
      }),
    } as unknown as Db;
    const svc = new KbAnalyticsService(db, auth);

    const result = await svc.citationReuse("org-1", {});

    const rendered = render(executed[0]);
    expect(rendered.sql.toLowerCase()).toContain("kb_chat_messages");
    expect(rendered.sql.toLowerCase()).toContain("kb_research_briefs");
    expect(rendered.sql.toLowerCase()).toContain("having count(*) >=");
    expect(rendered.params).toContain(2);
    expect(result).toEqual([{ kind: "page", refId: 4, title: "Refund policy", reuseCount: 3 }]);
  });
});
