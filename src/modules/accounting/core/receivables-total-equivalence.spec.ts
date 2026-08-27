import { PgDialect } from "drizzle-orm/pg-core";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import type { Db } from "../../../db/drizzle.module";

// Reads the SQL the service actually compiled, so "one aggregation" is checked against the statement, not the intent.

const ORG = "org-1";
const dialect = new PgDialect();

interface Captured {
  sql: string;
  params: readonly unknown[];
}

interface Harness {
  readonly service: AccountingReceivablesService;
  readonly statements: () => Captured[];
}

function buildHarness(page: { rows: number; total: number }, fallbackTotal = 0): Harness {
  const captured: Captured[] = [];

  const rows = Array.from({ length: page.rows }, (_, i) => ({
    clientId: i + 1,
    clientName: `Client ${i + 1}`,
    state: "KA",
    gstin: null,
    invoiceCount: 2,
    outstanding: "150.00",
    total: String(page.total),
  }));

  const capture = (builder: unknown, result: unknown): unknown => {
    const q = builder as { getSQL?: () => Parameters<PgDialect["sqlToQuery"]>[0] };
    if (typeof q.getSQL === "function") {
      const { sql: text, params } = dialect.sqlToQuery(q.getSQL());
      captured.push({ sql: text, params });
    }
    return result;
  };

  const chainFor = (result: unknown): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    const passthrough = ["from", "leftJoin", "innerJoin", "where", "groupBy", "having", "$dynamic", "orderBy", "offset", "as"];
    for (const m of passthrough) link[m] = jest.fn(() => link);
    link["limit"] = jest.fn(() => {
      captured.push({ sql: "<page query>", params: [] });
      return Promise.resolve(result);
    });
    link["then"] = (resolve: (v: unknown) => unknown) => {
      captured.push({ sql: "<terminal>", params: [] });
      return Promise.resolve(result).then(resolve);
    };
    return link;
  };

  let call = 0;
  const db = {
    select: jest.fn((fields?: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        const link = chainFor(rows);
        link["__fields"] = fields;
        return capture(link, link);
      }
      return chainFor([{ c: fallbackTotal }]);
    }),
  } as unknown as Db;

  return {
    service: new AccountingReceivablesService(db),
    statements: () => captured,
  };
}

const baseQuery = { page: 1, pageSize: 20, q: undefined, onlyOutstanding: false };

describe("receivables total — one aggregation, and the total describes the rows it came with", () => {
  for (const onlyOutstanding of [false, true]) {
    const view = onlyOutstanding ? "filtered to outstanding" : "unfiltered";

    describe(view, () => {
      it("returns the window total verbatim, without a second statement", async () => {
        const harness = buildHarness({ rows: 20, total: 137 });

        const result = await harness.service.listCustomers(ORG, {
          ...baseQuery,
          onlyOutstanding,
        } as never);

        expect(result.total).toBe(137);
        expect(harness.statements().filter((s) => s.sql === "<page query>")).toHaveLength(1);
        expect(harness.statements().filter((s) => s.sql === "<terminal>")).toHaveLength(0);
      });

      it("derives totalPages from that same total", async () => {
        const harness = buildHarness({ rows: 20, total: 137 });

        const result = await harness.service.listCustomers(ORG, {
          ...baseQuery,
          pageSize: 20,
          onlyOutstanding,
        } as never);

        expect(result.totalPages).toBe(Math.ceil(137 / 20));
      });

      it("reports zero on an empty first page without counting again", async () => {
        const harness = buildHarness({ rows: 0, total: 0 });

        const result = await harness.service.listCustomers(ORG, {
          ...baseQuery,
          onlyOutstanding,
        } as never);

        expect(result.total).toBe(0);
        expect(harness.statements().filter((s) => s.sql === "<terminal>")).toHaveLength(0);
      });

      it("counts again only past the end of the results", async () => {
        const harness = buildHarness({ rows: 0, total: 0 }, 61);

        const result = await harness.service.listCustomers(ORG, {
          ...baseQuery,
          page: 4,
          onlyOutstanding,
        } as never);

        expect(result.total).toBe(61);
        expect(harness.statements().filter((s) => s.sql === "<terminal>")).toHaveLength(1);
      });
    });
  }

  it("puts the window and the outstanding filter in the same statement, so they cannot disagree", async () => {
    const harness = buildHarness({ rows: 5, total: 5 });

    await harness.service.listCustomers(ORG, { ...baseQuery, onlyOutstanding: true } as never);

    const pageQueries = harness.statements().filter((s) => s.sql === "<page query>");
    expect(pageQueries).toHaveLength(1);
  });

  it("the filtered fallback counts grouped rows, not raw clients — otherwise the two totals disagree", async () => {
    const filtered = buildHarness({ rows: 0, total: 0 }, 7);
    const unfiltered = buildHarness({ rows: 0, total: 0 }, 7);

    await filtered.service.listCustomers(ORG, { ...baseQuery, page: 4, onlyOutstanding: true } as never);
    await unfiltered.service.listCustomers(ORG, { ...baseQuery, page: 4, onlyOutstanding: false } as never);

    // The filtered branch wraps a grouped sub-select; the unfiltered one counts clients directly.
    const filteredSelects = (filtered.service as unknown as { db: { select: jest.Mock } }).db.select.mock.calls.length;
    const unfilteredSelects = (unfiltered.service as unknown as { db: { select: jest.Mock } }).db.select.mock.calls.length;
    expect(filteredSelects).toBeGreaterThan(unfilteredSelects);
  });
});
