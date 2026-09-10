import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  glOrphanJournalsSql,
  glReconRowsSql,
  glReconSummarySql,
  glUnpostedByDesignSql,
} from "../lib/gl-recon-sql";
import { resolveGlPostingRules } from "../gl-posting-rules";
import { PURPOSE_DEFAULT_CODE } from "../../../../accounting/posting/finance-posting-accounts.service";
import {
  INVENTORY_JOURNAL_PURPOSES,
  type InventoryAccountCodes,
} from "../../../stock-engine/accounting-bridge";

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);

/**
 * INV-09 — the account codes the rules resolve against.
 *
 * Built from `PURPOSE_DEFAULT_CODE` rather than typed out, so these are exactly
 * what an organisation that has mapped nothing gets, and the "unmapped org still
 * sees 1300" assertions below are checking the real fallback rather than a
 * constant this file invented.
 */
function codesFor(overrides: Partial<InventoryAccountCodes> = {}): InventoryAccountCodes {
  return {
    ...(Object.fromEntries(
      INVENTORY_JOURNAL_PURPOSES.map((purpose) => [purpose, PURPOSE_DEFAULT_CODE[purpose]]),
    ) as InventoryAccountCodes),
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

describe("inventory-to-GL reconciliation SQL", () => {
  /**
   * The property the whole design turns on. `journal_entries` and
   * `ledger_accounts` are among the tables declared in Drizzle that do not exist
   * in every database — which is why the stock engine has an accounting bridge
   * at all. Postgres resolves table names when it plans, not when it runs, so a
   * runtime `installed` flag inside the statement would not save it: the
   * reference has to be absent from the text.
   */
  it("mentions no accounting table when the accounting module is not installed", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: false }));

    expect(query.sql).not.toContain("journal_entries");
    expect(query.sql).not.toContain("journal_lines");
    expect(query.sql).not.toContain("ledger_accounts");
    expect(query.sql).toContain("inv_stock_transactions");
  });

  it("says so rather than reporting every movement as unmatched", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: false }));

    expect(query.sql).toMatch(/WHEN\s+FALSE\s*=\s*FALSE\s+THEN\s+'ACCOUNTING_NOT_INSTALLED'/);
  });

  it("joins the journal on source type, source id and source event when installed", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(query.sql).toContain("je.source_type = m.reference_type");
    expect(query.sql).toContain("je.source_id = m.reference_id");
    expect(query.sql).toContain("je.source_event = r.source_event");
    expect(query.sql).toContain("ledger_accounts");
  });

  /**
   * Order matters and is the point of the report. A movement with no journal is
   * only "unmatched" once the chart of accounts has been ruled out — otherwise
   * the report blames the warehouse for a mapping nobody created.
   */
  it("decides MISSING_COA before UNMATCHED", () => {
    const { sql: text } = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(text).toContain("'MISSING_COA'");
    expect(text.indexOf("'MISSING_COA'")).toBeLessThan(text.indexOf("'UNMATCHED'"));
    expect(text.indexOf("'UNMATCHED'")).toBeLessThan(text.indexOf("'VALUE_MISMATCH'"));
  });

  it("only claims a value mismatch when the movement carries a cost", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(query.sql).toMatch(
      /m\.has_cost AND m\.movement_value <> 0 AND j\.debit_total <> m\.movement_value/,
    );
    expect(query.sql).toContain("'VALUE_MISMATCH'");
  });

  it("groups the ledger by document, not by ledger row", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(query.sql).toContain("GROUP BY t.reference_type, t.reference_id");
  });

  it("compares in numeric and hands out text, never a float", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(query.sql).toMatch(/movement_value::text\s+AS "movementValue"/);
    expect(query.sql).toMatch(/debit_total::text\s+AS "journalValue"/);
    expect(query.sql).not.toContain("float8");
    expect(query.sql).not.toContain("::real");
  });

  it("binds the window, the tenant and the page rather than inlining them", () => {
    const query = render(
      glReconRowsSql({ ...window, journalsInstalled: true, limit: 25, offset: 50 }),
    );

    expect(query.params).toContain("org-1");
    expect(query.params).toContain("2026-08-01");
    expect(query.params).toContain("2026-08-31");
    expect(query.params).toContain(25);
    expect(query.params).toContain(50);
  });

  it("filters to one status when the caller asks for one", () => {
    const query = render(
      glReconRowsSql({ ...window, ...page, journalsInstalled: true, status: "MISSING_COA" }),
    );

    expect(query.sql).toContain("classified.status = $");
    expect(query.params).toContain("MISSING_COA");
  });

  it("carries every posting rule into the statement", () => {
    const query = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(query.params).toContain("inv_grn");
    expect(query.params).toContain("receive");
    expect(query.params).toContain("inv_sales_order");
    expect(query.params).toContain("ship");
    expect(query.params).toContain("1300");
    expect(query.params).toContain("5000");
  });

  it("summarises the whole window, not the page", () => {
    const query = render(glReconSummarySql({ ...window, journalsInstalled: true }));

    expect(query.sql).toContain("count(*) FILTER (WHERE status = 'MATCHED')");
    expect(query.sql).toContain("count(*) FILTER (WHERE status = 'MISSING_COA')");

    // No *page* bound. The statement does carry one `LIMIT 1`, inside the
    // LATERAL that picks the newest journal entry for a source — that is a
    // per-group pick, not pagination, and banning the word outright would ban
    // the correct query along with the wrong one. What must not appear is an
    // OFFSET, or a LIMIT bound to the page size.
    expect(query.sql).not.toContain("OFFSET");
    expect(query.sql.match(/LIMIT/g) ?? []).toHaveLength(1);
    expect(query.sql).toContain("LIMIT 1");
    expect(query.params).not.toContain(page.limit);
  });

  /**
   * INV-09 — the trap the whole change turns on.
   *
   * Posting resolves INVENTORY_ASSET through `acc_system_account_map`. If this
   * table did not, a tenant that mapped INVENTORY_ASSET to 1355 would post to
   * 1355 and have the report look for 1300 — which the tenant does not have —
   * so every goods receipt in the period would come back MISSING_COA. The report
   * would be reporting its own stale expectation as a broken ledger.
   */
  it("expects the organisation's mapped account, not the default", () => {
    const mapped = render(
      glReconRowsSql({
        ...window,
        ...page,
        journalsInstalled: true,
        rules: resolveGlPostingRules(codesFor({ INVENTORY_ASSET: "1355" })),
      }),
    );

    expect(mapped.params).toContain("1355");
    expect(mapped.params).not.toContain("1300");
  });

  it("expects the default account for an organisation that mapped nothing", () => {
    const unmapped = render(glReconRowsSql({ ...window, ...page, journalsInstalled: true }));

    expect(unmapped.params).toContain("1300");
    expect(unmapped.params).not.toContain("1355");
  });

  it("carries a mapped account into the summary as well as the page", () => {
    // Two statements build the rules CTE and both had to be changed. A summary
    // still counting against 1300 while the page counts against 1355 would give
    // a report whose totals contradict its own rows.
    const query = render(
      glReconSummarySql({
        ...window,
        journalsInstalled: true,
        rules: resolveGlPostingRules(codesFor({ INVENTORY_ASSET: "1355" })),
      }),
    );

    expect(query.params).toContain("1355");
    expect(query.params).not.toContain("1300");
  });

  it("counts what no posting rule covers instead of calling it unmatched", () => {
    const query = render(glUnpostedByDesignSql(window));

    expect(query.sql).toContain("t.reference_type IS NULL OR t.reference_type NOT IN");
    expect(query.params).toContain("inv_grn");
    expect(query.sql).not.toContain("journal_entries");
  });

  it("looks for journals whose document never moved any stock", () => {
    const query = render(
      glOrphanJournalsSql({
        orgId: "org-1",
        fromDate: "2026-08-01",
        toDate: "2026-08-31",
        limit: 50,
      }),
    );

    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain("inv_stock_transactions");
    expect(query.sql).toContain("journal_entries");
  });
});
