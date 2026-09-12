import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  glOrphanJournalsSql,
  glReconRowsSql,
  glReconSummarySql,
  glUnpostedByDesignSql,
  stockBridgeReferenceTypes,
} from "../lib/gl-recon-sql";
import { resolveGlPostingRules } from "../gl-posting-rules";
import type { InventoryAccountCodes } from "../../../stock-engine/accounting-bridge";
import { STOCK_LEDGER_TABLES } from "../../../../accounting/adapters/reconciliation/stock-journal-sql";

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);

/** An organisation whose book tags every role inventory names. */
function codesFor(overrides: Partial<InventoryAccountCodes> = {}): InventoryAccountCodes {
  return {
    INVENTORY_ASSET: "1300",
    INVENTORY_COGS: "5000",
    INVENTORY_GRNI: "2000",
    AP: "2000",
    AR: "1200",
    SALES_INCOME: "4000",
    ...overrides,
  };
}

const window = {
  orgId: "org-1",
  fromDate: "2026-08-01",
  toDate: "2026-08-31",
  locationScope: () => sql`TRUE`,
  rules: resolveGlPostingRules(codesFor()),
};
const page = { limit: 50, offset: 0 };
const enabled = { bookId: "book-1" };
const disabled = { bookId: null };

const LEGACY_TABLES = ["journal_entries", "journal_lines", "ledger_accounts", "acc_system_account_map"];

describe("inventory-to-GL reconciliation SQL, on the accounting kernel", () => {
  it("names no ledger table when the organisation keeps no books", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...disabled }));

    // The names come from accounting: the ledger boundary keeps them out of
    // every inventory file, this one included.
    for (const table of STOCK_LEDGER_TABLES) expect(query.sql).not.toContain(table);
    expect(query.sql).toContain("inv_stock_transactions");
  });

  it("says so rather than reporting every movement as unmatched", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...disabled }));

    expect(query.sql).toMatch(/WHEN\s+FALSE\s*=\s*FALSE\s+THEN\s+'ACCOUNTING_NOT_INSTALLED'/);
    // And lists no missing role: nothing was ever expected.
    expect(query.sql).toContain("ARRAY[]::text[] AS missing_roles");
  });

  it("never reads the legacy accounting tables", () => {
    const statements = [
      glReconRowsSql({ ...window, ...page, ...enabled }),
      glReconSummarySql({ ...window, ...enabled }),
      glUnpostedByDesignSql(window),
      glOrphanJournalsSql({ orgId: "org-1", bookId: "book-1", fromDate: "2026-08-01", toDate: "2026-08-31", limit: 50 }),
    ];
    for (const statement of statements) {
      const text = render(statement).sql;
      // Word-bounded: `journal_lines` is a substring of the kernel's own table.
      for (const table of LEGACY_TABLES) expect(text).not.toMatch(new RegExp(`\\b${table}\\b`));
    }
  });

  it("matches a journal on the kernel's idempotency key, inside the organisation's book", () => {
    // The ledger read itself is accounting's (stock-journal-sql.spec.ts); what
    // this asserts is that inventory wires its own columns into it.
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toContain(
      "gj.idempotency_key = 'stock_move:' || m.reference_id || ':' || r.source_event",
    );
    expect(query.sql).toMatch(/gj\.org_id = \$\d+/);
    expect(query.sql).toMatch(/gj\.book_id = \$\d+/);
    expect(query.params).toContain("org-1");
    expect(query.params).toContain("book-1");
  });

  it("reaches a shipment's COGS through the shipments of the order the movements reference", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toContain("r.keyed_on = 'shipment'");
    expect(query.sql).toContain("s.so_id::text = m.reference_id");
  });

  it("sums every journal a group matched, so a second shipment is not a mismatch", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toContain("SUM(sj.debit_minor)::bigint");
  });

  /**
   * Order matters and is the point of the report. A movement with no journal is
   * only "unmatched" once the chart has been ruled out — otherwise the report
   * blames the warehouse for a role nobody assigned.
   */
  it("decides MISSING_COA before UNMATCHED before VALUE_MISMATCH", () => {
    const { sql: text } = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(text.indexOf("'MISSING_COA'")).toBeGreaterThan(-1);
    expect(text.indexOf("'MISSING_COA'")).toBeLessThan(text.indexOf("'UNMATCHED'"));
    expect(text.indexOf("'UNMATCHED'")).toBeLessThan(text.indexOf("'VALUE_MISMATCH'"));
  });

  it("compares in minor units, rounded the way every post rounds, and only when there is a cost", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toMatch(
      /m\.has_cost AND m\.movement_value <> 0 AND j\.debit_minor <> round\(m\.movement_value \* 100\)/,
    );
  });

  it("groups the ledger by document, not by ledger row", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toContain("GROUP BY t.reference_type, t.reference_id");
  });

  it("hands out text in one unit, never a float", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    expect(query.sql).toMatch(/movement_value::text\s+AS "movementValue"/);
    expect(query.sql).toMatch(/\(\(classified\.debit_minor\)::numeric \/ 100\)::numeric\(20, 2\)::text\s+AS "journalValue"/);
    expect(query.sql).not.toContain("float8");
    expect(query.sql).not.toContain("::real");
  });

  it("binds the window, the tenant and the page rather than inlining them", () => {
    const query = render(glReconRowsSql({ ...window, ...enabled, limit: 25, offset: 50 }));

    expect(query.params).toContain("org-1");
    expect(query.params).toContain("2026-08-01");
    expect(query.params).toContain("2026-08-31");
    expect(query.params).toContain(25);
    expect(query.params).toContain(50);
  });

  it("filters to one status when the caller asks for one", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled, status: "MISSING_COA" }));

    expect(query.sql).toContain("classified.status = $");
    expect(query.params).toContain("MISSING_COA");
  });

  it("carries every rule and this organisation's codes into the statement", () => {
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled }));

    for (const value of ["inv_grn", "receive", "inv_sales_order", "ship", "inv_landed_cost", "landed_cost", "1300", "5000"]) {
      expect(query.params).toContain(value);
    }
  });

  it("summarises the whole window, not the page", () => {
    const query = render(glReconSummarySql({ ...window, ...enabled }));

    expect(query.sql).toContain("count(*) FILTER (WHERE status = 'MATCHED')");
    expect(query.sql).toContain("count(*) FILTER (WHERE status = 'MISSING_COA')");
    expect(query.sql).not.toContain("OFFSET");
    expect(query.sql).not.toContain("LIMIT");
    expect(query.params).not.toContain(page.limit);
  });

  /**
   * INV-09 — the trap the design turns on. Posting resolves the inventory role
   * through the book's tags. If the report read its codes any other way, a
   * tenant that re-tagged 1355 as `inventory` would have the report still
   * looking for 1300.
   */
  it("carries a re-tagged chart into the page and the summary alike", () => {
    const rules = resolveGlPostingRules(codesFor({ INVENTORY_ASSET: "1355" }));
    for (const statement of [
      glReconRowsSql({ ...window, ...page, ...enabled, rules }),
      glReconSummarySql({ ...window, ...enabled, rules }),
    ]) {
      const query = render(statement);
      expect(query.params).toContain("1355");
      expect(query.params).not.toContain("1300");
    }
  });

  it("names an unfilled role as the row's missing account", () => {
    const rules = resolveGlPostingRules(codesFor({ INVENTORY_ASSET: null }));
    const query = render(glReconRowsSql({ ...window, ...page, ...enabled, rules }));

    expect(query.sql).toContain("r.missing_roles AS missing_roles");
    expect(query.params).toContain("inventory");
  });

  it("lists what no rule covers, and says which of it the stock bridge posts", () => {
    const query = render(glUnpostedByDesignSql(window));

    expect(query.sql).toContain("t.reference_type IS NULL OR t.reference_type NOT IN");
    expect(query.sql).toContain('AS "postedByStockBridge"');
    expect(query.params).toContain("inv_grn");
    expect(query.params).toContain("inv_adjustment");
    expect(query.params).toContain("inv_transfer");
    for (const table of STOCK_LEDGER_TABLES) expect(query.sql).not.toContain(table);
  });

  it("takes the stock bridge's reference types from the accounting module, minus the rules here", () => {
    const bridged = stockBridgeReferenceTypes();
    expect(bridged).toEqual(
      expect.arrayContaining([
        "inv_adjustment",
        "inv_cycle_count",
        "inv_physical_audit",
        "INSPECTION_DISPOSE",
        "inv_customer_return",
        "inv_vendor_return",
        "inv_transfer",
      ]),
    );
    expect(bridged).not.toContain("inv_grn");
  });

  it("looks for journals whose document never moved any stock, in the organisation's book", () => {
    const query = render(
      glOrphanJournalsSql({ orgId: "org-1", bookId: "book-1", fromDate: "2026-08-01", toDate: "2026-08-31", limit: 50 }),
    );

    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain("inv_stock_transactions");
    expect(query.sql).toMatch(/o\.journal_id\s+AS "journalEntryId"/);
    expect(query.sql).toContain("::numeric(20, 2)::text");
    for (const value of ["org-1", "book-1", "inv_grn", "receive", "inv_sales_order", "ship", "inv_landed_cost", "landed_cost"]) {
      expect(query.params).toContain(value);
    }
  });
});
