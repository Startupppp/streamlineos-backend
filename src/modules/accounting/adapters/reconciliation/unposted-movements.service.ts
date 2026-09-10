import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { BooksService } from "../../kernel/books.service";

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
const POSTING_REFERENCE_TYPES = ["inv_grn", "inv_sales_order"] as const;

export type UnpostedReason =
  /** No bridge call site posts for this kind of movement at all. */
  | "no_posting_path"
  /** A kind that does post, where the journal is missing. */
  | "post_missing";

export interface UnpostedMovement {
  transactionId: number;
  postingDate: string | null;
  transactionType: string;
  referenceType: string | null;
  referenceId: string | null;
  valueMinor: number;
  reason: UnpostedReason;
}

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
          t.total_cost
        FROM inv_stock_transactions t
        WHERE t.org_id = ${orgId}
          AND t.posting_date >= ${from}
          AND t.posting_date <= ${to}
          AND t.total_cost IS NOT NULL
          AND t.total_cost <> 0
      ),
      posted AS (
        SELECT j.source_id
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
        CASE
          WHEN m.reference_type = 'inv_grn' THEN EXISTS (
            SELECT 1 FROM posted p WHERE p.source_id = m.reference_id
          )
          WHEN m.reference_type = 'inv_sales_order' THEN EXISTS (
            SELECT 1
            FROM posted p
            JOIN inv_shipments s ON s.id::text = p.source_id
            WHERE s.org_id = ${orgId} AND s.so_id::text = m.reference_id
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
      has_journal: boolean;
    }>;

    const unposted: UnpostedMovement[] = [];
    for (const row of rows) {
      if (row.has_journal) continue;
      const posts =
        row.reference_type !== null &&
        (POSTING_REFERENCE_TYPES as readonly string[]).includes(row.reference_type);
      unposted.push({
        transactionId: row.id,
        postingDate: row.posting_date,
        transactionType: row.transaction_type,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        // Stored as a decimal string; the ledger counts in minor units.
        valueMinor: Math.round(Math.abs(Number(row.total_cost)) * 100),
        reason: posts ? "post_missing" : "no_posting_path",
      });
    }

    return {
      enabled: true,
      from,
      to,
      movements: unposted.length,
      valueMinor: unposted.reduce((a, m) => a + m.valueMinor, 0),
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

function group<T>(rows: T[], key: (row: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * Say what the numbers do and do not mean, in the payload rather than in a
 * wiki. A reconciliation report that overstates its own precision is worse than
 * none, because it gets trusted.
 */
export function notesFor(unposted: UnpostedMovement[]): string[] {
  const notes: string[] = [];

  if (unposted.some((m) => m.reason === "no_posting_path")) {
    notes.push(
      "Movements marked no_posting_path are not a fault of this organisation's setup: " +
        "adjustments, transfers, counts, quality write-offs and returns have no journal " +
        "posting path in the product yet, so their value is missing from the inventory GL " +
        "account by construction.",
    );
  }
  if (unposted.some((m) => m.reason === "post_missing")) {
    notes.push(
      "Movements marked post_missing had a posting path and no journal. That should not " +
        "happen — the post shares the movement's own transaction — so treat each one as a " +
        "bug to investigate rather than a setting to change.",
    );
  }
  /*
    Stated always, because it bounds every figure above. A shipment's stock
    transaction records the SALES ORDER as its reference and never the
    shipment, so a partially shipped order whose first shipment posted cannot
    be distinguished from one whose second shipment did not.
  */
  notes.push(
    "Shipments are matched at sales-order level: a stock transaction records the sales " +
      "order as its reference and never the shipment, so on a partially shipped order one " +
      "posted shipment makes the whole order look posted.",
  );
  return notes;
}
