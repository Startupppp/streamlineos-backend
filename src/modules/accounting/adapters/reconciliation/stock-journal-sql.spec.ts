import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  STOCK_LEDGER_TABLES,
  noStockJournalsLateral,
  orphanStockJournalsSql,
  stockJournalsLateral,
} from "./stock-journal-sql";

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);

const match = {
  orgId: "org-1",
  bookId: "book-1",
  referenceId: sql`m.reference_id`,
  purpose: sql`r.source_event`,
  keyedOn: sql`r.keyed_on`,
};

/**
 * The ledger read accounting lends to inventory's per-document reconciliation.
 * These are the assertions about ledger SQL that inventory's own spec may not
 * make, because the ledger boundary keeps ledger table names out of inventory.
 */
describe("stock journal SQL lent to inventory", () => {
  it("matches on the idempotency key PostingCommandService builds, inside one book", () => {
    const query = render(stockJournalsLateral(match, "j"));

    expect(query.sql).toContain("FROM gl_journals gj");
    expect(query.sql).toContain("gj.source_type = 'stock_move'");
    expect(query.sql).toContain(
      "gj.idempotency_key = 'stock_move:' || m.reference_id || ':' || r.source_event",
    );
    expect(query.sql).toMatch(/gj\.org_id = \$\d+/);
    expect(query.sql).toMatch(/gj\.book_id = \$\d+/);
    expect(query.params).toEqual(expect.arrayContaining(["org-1", "book-1"]));
  });

  it("reaches a shipment's journals through the shipments of the referenced order, tenant-fenced", () => {
    const { sql: text } = render(stockJournalsLateral(match, "j"));

    expect(text).toContain("r.keyed_on = 'shipment'");
    expect(text).toContain("s.so_id::text = m.reference_id");
    expect(text).toMatch(/s\.org_id = \$\d+/);
  });

  it("sums debits across every journal it matched, and reads lines within the tenant", () => {
    const { sql: text } = render(stockJournalsLateral(match, "j"));

    expect(text).toContain("SUM(sj.debit_minor)::bigint");
    expect(text).toContain("FROM gl_journal_lines jl");
    expect(text).toContain("jl.org_id = gj.org_id");
    expect(text).toContain(") j ON TRUE");
  });

  it("names no ledger table for an organisation with no book", () => {
    const { sql: text } = render(noStockJournalsLateral("j"));

    for (const table of STOCK_LEDGER_TABLES) expect(text).not.toContain(table);
    expect(text).toContain("NULL::bigint AS debit_minor");
  });

  it("refuses an alias that is not a plain identifier", () => {
    // Named, because the alias reaches `sql.raw` — a bare `.toThrow()` here is
    // also satisfied by a TypeError from a mis-shaped argument, which would pass
    // while the injection guard was gone.
    expect(() => stockJournalsLateral(match, "j; DROP TABLE x")).toThrow(
      /Not a usable SQL alias: "j; DROP TABLE x"/,
    );
    expect(() => noStockJournalsLateral("1j")).toThrow(/Not a usable SQL alias: "1j"/);
  });

  it("finds journals whose document never moved stock, in one book and one window", () => {
    const query = render(
      orphanStockJournalsSql({
        orgId: "org-1",
        bookId: "book-1",
        fromDate: "2026-08-01",
        toDate: "2026-08-31",
        limit: 50,
        rules: [
          { referenceType: "inv_grn", purpose: "receive", keyedOn: "reference" },
          { referenceType: "inv_sales_order", purpose: "ship", keyedOn: "shipment" },
        ],
      }),
    );

    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain("inv_stock_transactions");
    expect(query.sql).toContain("gj.idempotency_key = 'stock_move:' || gj.source_id || ':' || r.purpose");
    expect(query.params).toEqual(
      expect.arrayContaining(["org-1", "book-1", "2026-08-01", "2026-08-31", 50, "inv_grn", "ship"]),
    );
  });
});
