import { and, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { KbContentHealthService } from "./kb-content-health.service";
import { impactKeysetAfterAnchor } from "./kb-content-health-signal-predicates";
import type { ContentHealthSignalsQuery } from "./dto/kb-content-health.schemas";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

interface FixtureRow {
  readonly id: number;
  readonly impact: number;
}

const FIXTURE: FixtureRow[] = [
  { id: 1, impact: 10 },
  { id: 2, impact: 90 },
  { id: 3, impact: 50 },
  { id: 4, impact: 70 },
  { id: 5, impact: 30 },
  { id: 6, impact: 60 },
  { id: 7, impact: 60 },
];

const IMPACT_ORDER = [2, 4, 6, 7, 3, 5, 1];

interface SortKey {
  readonly field: "impact" | "id";
  readonly descending: boolean;
}

function readSortKeys(orderBy: unknown[]): SortKey[] {
  return orderBy.map((entry) => {
    const text = render(entry).toLowerCase();
    const field = text.includes("least(") ? "impact" : "id";
    return { field, descending: /\bdesc\s*$/.test(text.trim()) };
  });
}

function sortRows(rows: FixtureRow[], keys: SortKey[]): FixtureRow[] {
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const delta = left[key.field] - right[key.field];
      if (delta !== 0) return key.descending ? -delta : delta;
    }
    return 0;
  });
}

function applyCursorPredicateFromRenderedSql(
  rows: FixtureRow[],
  where: unknown,
): FixtureRow[] {
  const query = dialect.sqlToQuery(where as SQL);
  const text = query.sql;
  const anchorId = Number(query.params[query.params.length - 1]);

  if (/-"kb_pages"\."id"\)\s*<\s*\(/.test(text)) {
    const anchor = FIXTURE.find((row) => row.id === anchorId);
    if (anchor === undefined) return [];
    return rows.filter(
      (row) =>
        row.impact < anchor.impact ||
        (row.impact === anchor.impact && row.id > anchor.id),
    );
  }

  if (/"kb_pages"\."id"\s*>\s*\$\d+/.test(text)) {
    return rows.filter((row) => row.id > anchorId);
  }

  return rows;
}

function runQuery(where: unknown, orderBy: unknown[], limit: number): FixtureRow[] {
  const filtered = applyCursorPredicateFromRenderedSql(FIXTURE, where);
  return sortRows(filtered, readSortKeys(orderBy)).slice(0, limit);
}

interface SignalsHarness {
  db: Db;
  orderBy: unknown[];
  where: unknown;
}

function makeSignalsHarness(): SignalsHarness {
  const state: { orderBy: unknown[]; where: unknown } = {
    orderBy: [],
    where: undefined,
  };

  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (clause: unknown) => {
    state.where = clause;
    return chain;
  };
  chain.orderBy = (...entries: unknown[]) => {
    state.orderBy = entries;
    return chain;
  };
  chain.limit = (value: number) =>
    Promise.resolve(
      runQuery(state.where, state.orderBy, value).map((row) => ({
        id: row.id,
        title: `Page ${row.id}`,
        status: "published",
        spaceId: null,
        updatedAt: new Date("2025-01-01T00:00:00.000Z"),
        nextReviewAt: null,
        ownerMembershipId: null,
        impact: row.impact,
      })),
    );

  const db = { select: () => chain } as unknown as Db;
  return {
    db,
    get orderBy() {
      return state.orderBy;
    },
    get where() {
      return state.where;
    },
  };
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser() {
  return {
    orgId: "org-1",
    userId: "user-1",
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makeQuery(afterId: number | undefined): ContentHealthSignalsQuery {
  return {
    signalType: "unowned",
    limit: 2,
    afterId,
    spaceId: undefined,
    ownerMembershipId: undefined,
  };
}

describe("KbContentHealthService.signals — keyset agrees with the impact sort", () => {
  it("carries the impact score into the cursor comparison, because paging by id alone under an impact sort drops every row whose id is lower than the last one shown", async () => {
    const harness = makeSignalsHarness();
    const svc = new KbContentHealthService(harness.db, auth as never);

    const first = await svc.signals(makeUser(), makeQuery(undefined));
    expect(first.data.map((row) => row.id)).toEqual([2, 4]);
    expect(first.nextCursor).toBe(4);

    const second = await svc.signals(makeUser(), makeQuery(first.nextCursor ?? undefined));
    expect(second.data.map((row) => row.id)).toEqual([6, 7]);
  });

  it("serves no row twice and skips none across three pages of a fixture whose id order disagrees with its impact order", async () => {
    const harness = makeSignalsHarness();
    const svc = new KbContentHealthService(harness.db, auth as never);

    const seen: number[] = [];
    let cursor: number | undefined = undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await svc.signals(makeUser(), makeQuery(cursor));
      seen.push(...result.data.map((row) => row.id));
      cursor = result.nextCursor ?? undefined;
    }

    expect(seen).toEqual(IMPACT_ORDER.slice(0, 6));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("control: the id-only predicate this replaced re-serves rows and skips two, so the harness can tell the two implementations apart", async () => {
    const harness = makeSignalsHarness();
    const svc = new KbContentHealthService(harness.db, auth as never);
    await svc.signals(makeUser(), makeQuery(undefined));

    const idOnly = and(
      eq(kbPages.orgId, "org-1"),
      isNull(kbPages.deletedAt),
      gt(kbPages.id, 4),
    );
    const reverted = runQuery(idOnly, harness.orderBy, 3).map((row) => row.id);

    expect(reverted).toEqual([6, 7, 5]);
    expect(reverted).not.toContain(3);
  });

  it("orders by the impact expression descending then id ascending, which is the order the cursor tuple mirrors", async () => {
    const harness = makeSignalsHarness();
    const svc = new KbContentHealthService(harness.db, auth as never);
    await svc.signals(makeUser(), makeQuery(undefined));

    const rendered = harness.orderBy.map((entry) => render(entry).toLowerCase());
    expect(rendered[0]).toContain("least(");
    expect(rendered[0]?.trim().endsWith("desc")).toBe(true);
    expect(rendered[1]).toContain('"kb_pages"."id" asc');
  });

  it("compares the impact expression and the id as a single row tuple, because two separate comparisons cannot express one keyset position", () => {
    const rendered = render(impactKeysetAfterAnchor("org-1", 42));
    expect(rendered).toContain('-"kb_pages"."id")');
    expect(rendered).toMatch(/\)\s*<\s*\(/);
    expect(rendered.match(/least\(/gi)?.length).toBe(4);
  });

  it("binds every keyset tuple value through sql.param, because an inlined value in a tuple comparison is a defect class this repo has already paid for", () => {
    const query = dialect.sqlToQuery(impactKeysetAfterAnchor("org-9", 4242));

    expect(query.sql).not.toContain("4242");
    expect(query.sql).not.toContain("org-9");
    expect(query.params).toEqual(expect.arrayContaining([4242, "org-9"]));
    expect(query.sql).toMatch(/\$\d+::int/);
  });

  it("resolves the anchor impact without filtering deleted_at, so a page soft-deleted between two requests does not truncate the rest of the list", () => {
    const rendered = render(impactKeysetAfterAnchor("org-1", 42)).toLowerCase();
    expect(rendered).toContain("select");
    expect(rendered).toContain('"kb_pages"."org_id"');
    expect(rendered).not.toContain("deleted_at");
  });
});
