import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StockGlReconciliationService } from "./stock-gl-reconciliation.service";
import type { UnpostedMovementsReport } from "./unposted-movements.service";

/**
 * ACC-09. Does the general ledger agree with the stock ledger about inventory?
 *
 * The ticket says "stock valuation vs GL inventory balances", and that literal
 * comparison is not available from here. `InvValuationService` is paginated and
 * scoped to the caller's warehouses — a books-level reconciliation whose answer
 * depends on who is looking is not a reconciliation — and re-deriving the
 * valuation in accounting would mean copying inventory's FIFO, standard and
 * average costing branches, at which point the report starts finding
 * differences it invented itself.
 *
 * So this compares the two figures that must agree EXACTLY: the inventory
 * account's net movement from `stock_move` journals, and the value of the
 * movements that produced them. On a healthy bridge that difference is zero,
 * and a non-zero value is a bridge defect rather than a setting.
 *
 * The remaining warehouse-to-balance-sheet gap — the movements nothing posts —
 * sits beside it as an attributed figure rather than being folded in.
 */

function serviceWith(opts: {
  glMinor: number;
  postedMinor: number;
  unpostedMinor?: number;
  byTransactionType?: UnpostedMovementsReport["byTransactionType"];
  book?: { id: string } | null;
}) {
  let call = 0;
  const db = {
    execute: async () => {
      /* The service issues the GL query first, then the posted-value query. */
      const value = call === 0 ? opts.glMinor : opts.postedMinor;
      call += 1;
      return [{ net: String(value) }];
    },
  } as never;

  const books = {
    findDefault: async () => (opts.book === undefined ? { id: "book-1" } : opts.book),
  } as never;

  const unposted = {
    report: async (): Promise<UnpostedMovementsReport> => ({
      enabled: true,
      from: "2026-09-01",
      to: "2026-09-30",
      movements: 0,
      valueMinor: opts.unpostedMinor ?? 0,
      byReason: [],
      byTransactionType: opts.byTransactionType ?? [],
      sample: [],
      notes: [],
    }),
  } as never;

  return new StockGlReconciliationService(db, books, unposted);
}

const WINDOW = ["2026-09-01", "2026-09-30"] as const;

describe("the ledger against the stock ledger", () => {
  it("says nothing about an org with no book", async () => {
    const report = await serviceWith({ glMinor: 0, postedMinor: 0, book: null }).report(
      "org-1",
      ...WINDOW,
    );

    expect(report.enabled).toBe(false);
    expect(report.notes[0]).toMatch(/no ledger to reconcile against/);
  });

  it("is balanced when the bridge posted everything that moved", async () => {
    const report = await serviceWith({ glMinor: 500_000, postedMinor: 500_000 }).report(
      "org-1",
      ...WINDOW,
    );

    expect(report.bridgeDifferenceMinor).toBe(0);
    expect(report.verdict).toBe("balanced");
  });

  it("separates the known gap from a bridge defect", async () => {
    /*
      The distinction the whole report exists for. The bridge is perfect and the
      books still differ from the warehouse, because ten movement types post
      nothing. Calling that "unbalanced" would send someone hunting a bug that
      is not there; folding it into one number would hide a real one.
    */
    const report = await serviceWith({
      glMinor: 500_000,
      postedMinor: 500_000,
      unpostedMinor: 40_000,
    }).report("org-1", ...WINDOW);

    expect(report.bridgeDifferenceMinor).toBe(0);
    expect(report.unpostedValueMinor).toBe(40_000);
    expect(report.verdict).toBe("explained_by_unposted");
  });

  it("calls a bridge difference unexplained, even when unposted value exists", async () => {
    /*
      The failure mode worth guarding: a report that let a large unposted figure
      absorb a real bridge defect would report "explained" over a genuine bug.
      The two are computed independently and the verdict is driven by the bridge
      difference alone.
    */
    const report = await serviceWith({
      glMinor: 500_000,
      postedMinor: 450_000,
      unpostedMinor: 900_000,
    }).report("org-1", ...WINDOW);

    expect(report.bridgeDifferenceMinor).toBe(50_000);
    expect(report.verdict).toBe("unexplained");
    expect(report.notes.join(" ")).toMatch(/defect in the bridge/);
  });

  it("tolerates a rupee of rounding and no more", async () => {
    /*
      Stock cost is 4dp and the ledger counts 2dp minor units, so a long tail of
      movements rounds. One rupee absorbs that; anything larger is arithmetic
      going wrong somewhere, and a generous tolerance is how a reconciliation
      quietly stops reconciling.
    */
    const withinTolerance = await serviceWith({ glMinor: 500_100, postedMinor: 500_000 }).report(
      "org-1",
      ...WINDOW,
    );
    expect(withinTolerance.verdict).toBe("balanced");

    const beyond = await serviceWith({ glMinor: 500_101, postedMinor: 500_000 }).report(
      "org-1",
      ...WINDOW,
    );
    expect(beyond.verdict).toBe("unexplained");
  });

  it("reports a difference in either direction", async () => {
    /*
      The ledger can be under as easily as over — a shipment that posted COGS
      and no inventory credit lands here as a negative. An `abs()` in the
      verdict without a signed figure in the payload would tell an operator
      there is a problem and not which way it points.
    */
    const report = await serviceWith({ glMinor: 400_000, postedMinor: 500_000 }).report(
      "org-1",
      ...WINDOW,
    );

    expect(report.bridgeDifferenceMinor).toBe(-100_000);
    expect(report.verdict).toBe("unexplained");
  });

  it("hands over the biggest gaps rather than only a total", async () => {
    const report = await serviceWith({
      glMinor: 0,
      postedMinor: 0,
      unpostedMinor: 100_000,
      byTransactionType: [
        { transactionType: "SCRAP", reason: "no_posting_path", movements: 4, valueMinor: 90_000 },
        {
          transactionType: "CYCLE_COUNT_LOSS",
          reason: "no_posting_path",
          movements: 1,
          valueMinor: 10_000,
        },
      ],
    }).report("org-1", ...WINDOW);

    expect(report.exceptions[0]!.transactionType).toBe("SCRAP");
    expect(report.exceptions).toHaveLength(2);
  });

  it("states what it is not comparing, in the payload", async () => {
    /*
      A reader will assume "reconciliation" means the stock valuation. Saying
      otherwise only in a code comment leaves that assumption intact for the
      person acting on the number.
    */
    const report = await serviceWith({ glMinor: 0, postedMinor: 0 }).report("org-1", ...WINDOW);
    expect(report.notes.join(" ")).toMatch(/not against a re-derived stock valuation/);
  });
});

describe("the queries behind it", () => {
  const source = readFileSync(join(__dirname, "stock-gl-reconciliation.service.ts"), "utf8");

  it("resolves the inventory account by role, never by code", () => {
    /*
      A tenant may renumber their chart. A reconciliation keyed on "1300" would
      silently start reading a different account the day they did, and would
      keep reporting a number.
    */
    expect(source).toContain("a.system_tag = 'inventory'");
    expect(source).not.toContain("a.code = '1300'");
  });

  it("counts only journals the stock bridge wrote", () => {
    /*
      Opening balances and manual journals touch the same account with a
      different `source_type`. Including them would let a correcting journal
      mask a bridge defect, or make one appear.
    */
    const glQuery = source.slice(source.indexOf("FROM gl_journal_lines"));
    expect(glQuery.slice(0, 600)).toContain("j.source_type = 'stock_move'");
  });

  it("signs the movement value, because total_cost never does", () => {
    /*
      The bug this file's mocks could not see, and the reason it survived
      review: every test above hands the verdict logic two numbers that are
      already signed, so the arithmetic was proved correct over inputs the
      query could not actually produce.

      `total_cost` is a POSITIVE MAGNITUDE in both directions. `recordIssue`
      accumulates from zero over positive quantities and `applyCosting` writes
      that back onto the transaction, so an outflow's row looks exactly like an
      inflow's and the direction survives only in `quantity_change`. Summing
      the column raw therefore added shipments where the ledger subtracts them.

      Measured on the development database at the time of the fix: summed raw
      the movements came to 339,600 minor units, signed to 160,400, and the
      339,600 figure was wrong by 179,200 — exactly twice the 89,600 of
      outflow. A tenant that had merely received and shipped would have been
      told, in the report's own words, that it had "a defect in the bridge".
    */
    const movementQuery = source.slice(source.indexOf("FROM inv_stock_transactions"));
    expect(source).toContain("round(t.total_cost * 100) * sign(t.quantity_change)");
    expect(movementQuery.slice(0, 200)).not.toMatch(/SUM\(round\(t\.total_cost \* 100\)\)/);
  });

  it("leaves the unposted-movements report counting magnitudes, which is correct there", () => {
    /*
      The two reports want opposite things from the same column and the
      distinction is easy to erase by making them "consistent". ACC-09 measures
      a balance, so direction matters; ACC-08 measures the SIZE of a gap, where
      a receipt nobody posted and a shipment nobody posted are both missing
      value and signing them would let one hide the other.
    */
    const unposted = readFileSync(join(__dirname, "unposted-movements.service.ts"), "utf8");
    expect(unposted).toContain("Math.abs(Number(row.total_cost))");
    expect(unposted).not.toContain("sign(t.quantity_change)");
  });

  it("binds the org on both sides of every join", () => {
    /*
      Raw SQL, so no `eq(table.orgId, …)` guards it — the same exposure the
      unposted-movements report has, and the shipment join is again the place
      another organisation's row could answer this one's question.
    */
    const shipmentJoin = source.slice(source.indexOf("JOIN inv_shipments"));
    expect(shipmentJoin.slice(0, 300)).toContain("s.org_id = ${orgId}");
  });
});
