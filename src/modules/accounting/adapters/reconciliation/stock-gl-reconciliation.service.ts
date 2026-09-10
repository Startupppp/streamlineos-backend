import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { BooksService } from "../../kernel/books.service";
import { UnpostedMovementsService } from "./unposted-movements.service";

export type ReconciliationVerdict =
  /** The bridge posted exactly what the stock ledger says moved. */
  | "balanced"
  /** It differs, and the difference is entirely the movements nothing posts. */
  | "explained_by_unposted"
  /** It differs by more than that. Something in the bridge is wrong. */
  | "unexplained";

export interface StockGlReconciliation {
  enabled: boolean;
  from: string;
  to: string;
  /** Net movement of the inventory account from stock_move journals, in minor units. */
  glMovementMinor: number;
  /** Value of the stock movements that produced those journals. */
  postedMovementValueMinor: number;
  /** Value of movements with no journal at all (ACC-08). */
  unpostedValueMinor: number;
  /** `glMovementMinor - postedMovementValueMinor`. Zero on a healthy bridge. */
  bridgeDifferenceMinor: number;
  verdict: ReconciliationVerdict;
  /** The largest unposted gaps, so an operator has somewhere to start. */
  exceptions: Array<{
    transactionType: string;
    reason: string;
    movements: number;
    valueMinor: number;
  }>;
  notes: string[];
}

/** One rupee. Rounding between a 4dp stock cost and 2dp minor units. */
const TOLERANCE_MINOR = 100;

@Injectable()
export class StockGlReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly unposted: UnpostedMovementsService,
  ) {}

  /**
   * Does the general ledger agree with the stock ledger about inventory?
   *
   * **What this compares, and why not the obvious thing.** ACC-09 asks for
   * "stock valuation vs GL inventory balances". The stock valuation is not
   * comparable here as it stands: `InvValuationService.getValuationSummary` is
   * paginated and scoped to the *caller's* warehouses, and a books-level
   * reconciliation whose answer depends on who is looking is not a
   * reconciliation. Re-deriving the valuation here instead would mean copying
   * inventory's FIFO / STANDARD / AVERAGE branch into accounting, and a
   * duplicated costing rule drifts — at which point the reconciliation reports
   * differences it invented itself, which is worse than not having one.
   *
   * So this compares the two things that must agree **exactly**: the inventory
   * account's net movement from `stock_move` journals, and the value of the
   * stock movements that produced them. Every posted movement writes one
   * balanced pair touching the inventory account, so on a healthy bridge the
   * difference is zero and any non-zero value is a bridge defect — a rounding
   * error, a partial post, a journal against the wrong account.
   *
   * Opening balances and manual journals do not participate: they carry a
   * different `source_type`, so they cannot mask a bridge defect or be mistaken
   * for one.
   *
   * The remaining gap between the books and the warehouse — the movements
   * nothing posts at all — is reported beside it as the known, attributed
   * difference rather than folded into one number nobody can act on.
   */
  async report(orgId: string, from: string, to: string): Promise<StockGlReconciliation> {
    const book = await this.books.findDefault(orgId);
    if (!book) {
      return {
        enabled: false,
        from,
        to,
        glMovementMinor: 0,
        postedMovementValueMinor: 0,
        unpostedValueMinor: 0,
        bridgeDifferenceMinor: 0,
        verdict: "balanced",
        exceptions: [],
        notes: [
          "Accounting is not enabled for this organisation, so there is no ledger to reconcile against.",
        ],
      };
    }

    const [gl, posted, unposted] = await Promise.all([
      this.glInventoryMovementMinor(orgId, book.id, from, to),
      this.postedMovementValueMinor(orgId, book.id, from, to),
      this.unposted.report(orgId, from, to),
    ]);

    const bridgeDifferenceMinor = gl - posted;
    const verdict: ReconciliationVerdict =
      Math.abs(bridgeDifferenceMinor) <= TOLERANCE_MINOR
        ? unposted.valueMinor === 0
          ? "balanced"
          : "explained_by_unposted"
        : "unexplained";

    return {
      enabled: true,
      from,
      to,
      glMovementMinor: gl,
      postedMovementValueMinor: posted,
      unpostedValueMinor: unposted.valueMinor,
      bridgeDifferenceMinor,
      verdict,
      exceptions: unposted.byTransactionType.slice(0, 20),
      notes: this.notes(verdict, bridgeDifferenceMinor, unposted.valueMinor),
    };
  }

  /**
   * Net debits minus credits on the account tagged `inventory`, counting only
   * journals the stock bridge wrote.
   *
   * Resolved by system tag rather than by account code, for the same reason
   * every document does: a tenant is free to renumber their chart, and a
   * reconciliation keyed on "1300" would silently start reading a different
   * account the day they did.
   */
  private async glInventoryMovementMinor(
    orgId: string,
    bookId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const rows = (await this.db.execute(sql`
      SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net
      FROM gl_journal_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN gl_accounts a ON a.id = l.account_id
      WHERE j.org_id = ${orgId}
        AND j.book_id = ${bookId}
        AND j.source_type = 'stock_move'
        AND j.journal_date >= ${from}
        AND j.journal_date <= ${to}
        AND a.system_tag = 'inventory'
    `)) as unknown as Array<{ net: string }>;

    return Number(rows[0]?.net ?? 0);
  }

  /**
   * Value of the stock movements that reached the ledger, over the same window.
   *
   * Signed to match the GL side — and the sign has to be applied here, because
   * `total_cost` does not carry it. This comment previously claimed the
   * opposite and the query summed the column raw, which was wrong in the most
   * expensive direction: an outflow records a POSITIVE magnitude, so a tenant
   * that both received and shipped had its shipments added where the ledger
   * subtracts them, the difference came to twice the shipment value, and the
   * report called that "a defect in the bridge" on a bridge that was fine.
   *
   * Measured on the development database rather than argued from the code:
   * every SALE and TRANSFER_OUT row carries a positive `total_cost` and not
   * one row in the table is negative. `recordIssue` accumulates from zero over
   * positive quantities and `applyCosting` writes that magnitude back onto the
   * transaction, so the direction lives only in `quantity_change`.
   *
   * ACC-08's report is unaffected: it counts magnitudes deliberately, because
   * it measures the size of a gap rather than a balance.
   */
  private async postedMovementValueMinor(
    orgId: string,
    bookId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const rows = (await this.db.execute(sql`
      SELECT COALESCE(SUM(round(t.total_cost * 100) * sign(t.quantity_change)), 0)::bigint AS net
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.posting_date >= ${from}
        AND t.posting_date <= ${to}
        AND t.total_cost IS NOT NULL
        AND t.total_cost <> 0
        AND (
          (t.reference_type = 'inv_grn' AND EXISTS (
            SELECT 1 FROM gl_journals j
            WHERE j.org_id = ${orgId} AND j.book_id = ${bookId}
              AND j.source_type = 'stock_move' AND j.source_id = t.reference_id
          ))
          OR
          (t.reference_type = 'inv_sales_order' AND EXISTS (
            SELECT 1 FROM gl_journals j
            JOIN inv_shipments s ON s.id::text = j.source_id
            WHERE j.org_id = ${orgId} AND j.book_id = ${bookId}
              AND j.source_type = 'stock_move'
              AND s.org_id = ${orgId} AND s.so_id::text = t.reference_id
          ))
        )
    `)) as unknown as Array<{ net: string }>;

    return Number(rows[0]?.net ?? 0);
  }

  private notes(
    verdict: ReconciliationVerdict,
    bridgeDifferenceMinor: number,
    unpostedValueMinor: number,
  ): string[] {
    const notes: string[] = [];

    if (verdict === "unexplained") {
      notes.push(
        `The inventory account moved by ${bridgeDifferenceMinor} minor units more than the stock ` +
          "movements behind it. Every posted movement writes one balanced pair touching this " +
          "account, so this is a defect in the bridge — a partial post, a rounding error, or a " +
          "journal against the wrong account — and not a configuration to change.",
      );
    }

    if (unpostedValueMinor > 0) {
      notes.push(
        `A further ${unpostedValueMinor} minor units of stock moved and produced no journal at ` +
          "all. That is the balance-sheet-to-warehouse gap, and it is reported separately " +
          "because nobody in this product can currently close it — see the unposted-movements " +
          "report for the breakdown.",
      );
    }

    notes.push(
      "This compares the inventory account's movement against the value of the movements that " +
        "produced it, not against a re-derived stock valuation: valuing stock here would mean " +
        "copying inventory's FIFO, standard and average costing rules into accounting, and a " +
        "duplicated costing rule reports differences it invented itself.",
    );

    return notes;
  }
}
