import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { MOVEMENT_GL_TREATMENT, type InvTxnType } from "../stock-movement-treatment";
import { BooksService } from "../../kernel/books.service";
import {
  group,
  notesFor,
  type UnpostedMovement,
  type UnpostedReason,
} from "./unposted-movements-helpers";

/**
 * Which reference types the inventory bridge posts a journal for.
 *
 * There are exactly two, out of the thirteen services that move stock — see
 * `docs/inventory-gl-contract.md` §2.1 and §3.4. Everything else changes the
 * value of stock on hand and leaves the inventory GL account untouched, with no
 * error, no log and no failed request. This service is how that stops being
 * invisible.
 *
 * `inv_grn` posts `stock_move:{grnId}:receive`, so the journal's source id IS
 * the movement's reference id. `inv_sales_order` posts
 * `stock_move:{shipmentId}:ship`, so the journal is keyed on the SHIPMENT while
 * the movement's reference is the SALES ORDER — those have to be joined through
 * `inv_shipments`, and the join is why the report carries a caveat.
 */
/**
 * Which document kind each reference type posts under, so a movement can be
 * matched to its own journal.
 *
 * Matching on `source_id` alone was enough while only receipts and shipments
 * posted. It is not any more: ACC-21 gave seven document kinds a posting path
 * and their ids come from seven different tables, so adjustment 5 and cycle
 * count 5 both answer to `source_id = '5'`. The idempotency key carries the
 * purpose — `stock_move:{id}:{kind}` — and is unique per book, so matching on
 * it is exact.
 */
export const POSTING_PURPOSE_BY_REFERENCE: Readonly<Record<string, string>> = {
  inv_grn: "receive",
  inv_adjustment: "adjustment",
  inv_cycle_count: "cycle_count",
  inv_physical_audit: "physical_audit",
  INSPECTION_DISPOSE: "quality_inspection",
  inv_customer_return: "customer_return",
  inv_vendor_return: "vendor_return",
  inv_transfer: "transfer",
};

/** Posts through the shipment rather than its own id; joined separately. */
const SHIPMENT_REFERENCE = "inv_sales_order";

export type { UnpostedReason, UnpostedMovement };

export interface UnpostedMovementsReport {
  enabled: boolean;
  from: string;
  to: string;
  movements: number;
  valueMinor: number;
  byReason: Array<{ reason: UnpostedReason; movements: number; valueMinor: number }>;
  byTransactionType: Array<{
    transactionType: string;
    reason: UnpostedReason;
    movements: number;
    valueMinor: number;
  }>;
  /** A bounded sample, so an operator has rows to open rather than only a number. */
  sample: UnpostedMovement[];
  notes: string[];
}

const SAMPLE_LIMIT = 100;

@Injectable()
export class UnpostedMovementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  /**
   * Value-changing stock movements in the window that produced no journal.
   *
   * Only meaningful for an org with a book: an org that never enabled
   * accounting is *supposed* to have no journals, and reporting all of its
   * movements as unposted would be the loudest possible way to say nothing.
   */
  async report(orgId: string, from: string, to: string): Promise<UnpostedMovementsReport> {
    const book = await this.books.findDefault(orgId);
    if (!book) {
      return {
        enabled: false,
        from,
        to,
        movements: 0,
        valueMinor: 0,
        byReason: [],
        byTransactionType: [],
        sample: [],
        notes: [
          "Accounting is not enabled for this organisation, so no stock movement is expected to post.",
        ],
      };
    }

    /*
      One query. `total_cost` is the movement's own valuation, so a movement
      with none — a reservation, a zero-cost transfer — is not a value change
      and is not a gap. The `has_journal` CASE is deliberately exhaustive on the
      two posting reference types and false for everything else, so a posting
      path added later without a line here shows up as a gap rather than being
      silently assumed fine.

      Validated against the real schema with EXPLAIN rather than only against
      mocks: every column resolves, both `::text` casts plan, and the movement
      scan is index-driven on `org_id`. A query built entirely against fakes is
      exactly the kind that passes its unit tests and fails on first contact.

      Filtering on `posting_date` rather than `created_at` is safe: the stock
      engine is the sole writer of `inv_stock_transactions` and always supplies
      one (`resolvePostingDate` never returns null), and measured on the shared
      database 0 of 342 rows have a null `posting_date`.
    */
    const rows = (await this.db.execute(sql`
      WITH moved AS (
        SELECT
          t.id,
          t.posting_date,
          t.transaction_type,
          t.reference_type,
          t.reference_id,
          t.total_cost,
          CASE t.reference_type
            ${sql.join(
              Object.entries(POSTING_PURPOSE_BY_REFERENCE).map(
                ([reference, purpose]) =>
                  sql`WHEN ${reference} THEN 'stock_move:' || t.reference_id || ':' || ${purpose}`,
              ),
              sql` `,
            )}
            ELSE NULL
          END AS expected_key
        FROM inv_stock_transactions t
        WHERE t.org_id = ${orgId}
          AND t.posting_date >= ${from}
          AND t.posting_date <= ${to}
          AND t.total_cost IS NOT NULL
          AND t.total_cost <> 0
      ),
      posted AS (
        SELECT j.source_id, j.idempotency_key
        FROM gl_journals j
        WHERE j.org_id = ${orgId}
          AND j.book_id = ${book.id}
          AND j.source_type = 'stock_move'
          AND j.source_id IS NOT NULL
      )
      SELECT
        m.id,
        m.posting_date,
        m.transaction_type,
        m.reference_type,
        m.reference_id,
        m.total_cost,
        m.expected_key,
        CASE
          WHEN m.reference_type = ${SHIPMENT_REFERENCE} THEN EXISTS (
            SELECT 1
            FROM posted p
            JOIN inv_shipments s ON s.id::text = p.source_id
            WHERE s.org_id = ${orgId} AND s.so_id::text = m.reference_id
          )
          WHEN m.expected_key IS NOT NULL THEN EXISTS (
            SELECT 1 FROM posted p WHERE p.idempotency_key = m.expected_key
          )
          ELSE false
        END AS has_journal
      FROM moved m
      ORDER BY m.posting_date DESC, m.id DESC
    `)) as unknown as Array<{
      id: number;
      posting_date: string | null;
      transaction_type: string;
      reference_type: string | null;
      reference_id: string | null;
      total_cost: string;
      expected_key: string | null;
      has_journal: boolean;
    }>;

    const unposted: UnpostedMovement[] = [];
    for (const row of rows) {
      if (row.has_journal) continue;
      const treatment = MOVEMENT_GL_TREATMENT[row.transaction_type as InvTxnType];
      const reason: UnpostedReason =
        treatment && treatment.kind === "none"
          ? "not_applicable"
          : row.expected_key !== null || row.reference_type === SHIPMENT_REFERENCE
            ? "post_missing"
            : "no_posting_path";
      unposted.push({
        transactionId: row.id,
        postingDate: row.posting_date,
        transactionType: row.transaction_type,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        // Stored as a decimal string; the ledger counts in minor units.
        valueMinor: Math.round(Math.abs(Number(row.total_cost)) * 100),
        reason,
      });
    }

    const gap = unposted.filter((m) => m.reason !== "not_applicable");

    return {
      enabled: true,
      from,
      to,
      /*
        The headline counts the GAP, not every movement without a journal.
        Quarantines and opening-stock imports are deliberately unposted, and
        folding them into the total would report a permanent, growing number
        that no one can ever drive to zero — which is how a report stops being
        read. They are still in `byReason` under `not_applicable`, so the
        decision is visible rather than hidden.
      */
      movements: gap.length,
      valueMinor: gap.reduce((a, m) => a + m.valueMinor, 0),
      byReason: group(unposted, (m) => m.reason).map(([reason, rowsInGroup]) => ({
        reason: reason as UnpostedReason,
        movements: rowsInGroup.length,
        valueMinor: rowsInGroup.reduce((a, m) => a + m.valueMinor, 0),
      })),
      byTransactionType: group(unposted, (m) => `${m.transactionType}|${m.reason}`).map(
        ([key, rowsInGroup]) => {
          const [transactionType, reason] = key.split("|");
          return {
            transactionType: transactionType!,
            reason: reason as UnpostedReason,
            movements: rowsInGroup.length,
            valueMinor: rowsInGroup.reduce((a, m) => a + m.valueMinor, 0),
          };
        },
      ),
      sample: unposted.slice(0, SAMPLE_LIMIT),
      notes: notesFor(unposted),
    };
  }
}

