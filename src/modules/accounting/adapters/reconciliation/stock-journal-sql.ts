import { sql, type SQL } from "drizzle-orm";

/**
 * The ledger's half of a per-document stock reconciliation, lent to inventory.
 *
 * Inventory's GL reconciliation (`inventory/reconciliation/gl`) compares each
 * stock document with the journals posted for it, and it does that in one
 * statement so Postgres can classify, count and page the whole window. The
 * ledger boundary (`ledger-boundary.spec.ts`) keeps ledger table and column
 * names inside accounting, so accounting owns this SQL and inventory composes
 * it. Read-only, and every fragment is fenced to one organisation's book.
 *
 * A stock journal is `source_type = 'stock_move'`, keyed
 * `stock_move:{sourceId}:{purpose}` (the key `PostingCommandService` builds and
 * `LedgerService` holds unique per book). A document matches its journals in
 * one of two ways:
 *
 *   reference  the journal's source id is the movement's reference id, as a
 *              receipt is keyed on its GRN;
 *   shipment   the movements reference a sales order and the journal is keyed
 *              on one of its shipments, as COGS is.
 *
 * `unposted-movements.service.ts` answers the same matching question for its
 * own report, per transaction rather than per document.
 */

/** The tables these fragments read, named once, for callers that must show they do not. */
export const STOCK_LEDGER_TABLES = ["gl_journals", "gl_journal_lines"] as const;

export type StockJournalKeying = "reference" | "shipment";

export interface StockJournalMatch {
  orgId: string;
  bookId: string;
  /** The stock document's reference id, as an expression of the outer query. */
  referenceId: SQL;
  /** The posting purpose (the key's last segment), as an expression. */
  purpose: SQL;
  /** `'reference'` or `'shipment'`, as an expression. */
  keyedOn: SQL;
}

const ALIAS = /^[a-z][a-z0-9_]*$/;

function alias(name: string): SQL {
  if (!ALIAS.test(name)) throw new Error(`Not a usable SQL alias: ${JSON.stringify(name)}`);
  return sql.raw(name);
}

/**
 * `LEFT JOIN LATERAL (…) <as> ON TRUE`, one row per outer row:
 *
 *   entry_id       the latest matched journal's id, NULL when nothing matched
 *   entry_number   its journal number
 *   entry_date     the latest journal date
 *   entry_status   'POSTED', 'REVERSED' (a reversal is linked to it) or NULL
 *   debit_minor    debits across EVERY matched journal, in minor units, or NULL
 *
 * Aggregated because the shipment arm can match several journals: a partially
 * shipped order has one COGS journal per shipment, and the document is the
 * whole order.
 */
export function stockJournalsLateral(match: StockJournalMatch, as: string): SQL {
  const { orgId, bookId, referenceId, purpose, keyedOn } = match;
  return sql`
    LEFT JOIN LATERAL (
      SELECT (array_agg(sj.id ORDER BY sj.posted_at DESC, sj.id DESC))[1]             AS entry_id,
             (array_agg(sj.journal_number ORDER BY sj.posted_at DESC, sj.id DESC))[1] AS entry_number,
             MAX(sj.journal_date)                                                      AS entry_date,
             CASE
               WHEN count(sj.id) = 0 THEN NULL
               WHEN bool_or(sj.reversed_by_journal_id IS NOT NULL) THEN 'REVERSED'
               ELSE 'POSTED'
             END                                                                       AS entry_status,
             SUM(sj.debit_minor)::bigint                                               AS debit_minor
      FROM (
        SELECT gj.id,
               gj.journal_number,
               gj.journal_date,
               gj.posted_at,
               gj.reversed_by_journal_id,
               (
                 SELECT COALESCE(SUM(jl.debit_minor), 0)
                 FROM gl_journal_lines jl
                 WHERE jl.journal_id = gj.id AND jl.org_id = gj.org_id
               ) AS debit_minor
        FROM gl_journals gj
        WHERE gj.org_id = ${orgId}
          AND gj.book_id = ${bookId}
          AND gj.source_type = 'stock_move'
          AND (
            (${keyedOn} = 'reference'
              AND gj.idempotency_key = 'stock_move:' || ${referenceId} || ':' || ${purpose})
            OR
            (${keyedOn} = 'shipment'
              AND gj.idempotency_key = 'stock_move:' || gj.source_id || ':' || ${purpose}
              AND gj.source_id IN (
                SELECT s.id::text FROM inv_shipments s
                WHERE s.org_id = ${orgId} AND s.so_id::text = ${referenceId}
              ))
          )
      ) sj
    ) ${alias(as)} ON TRUE`;
}

/**
 * The same columns, all NULL, for an organisation that keeps no book: there is
 * nothing to match, and the statement then names no ledger table at all.
 */
export function noStockJournalsLateral(as: string): SQL {
  return sql`
    LEFT JOIN LATERAL (
      SELECT NULL::text AS entry_id, NULL::text AS entry_number, NULL::date AS entry_date,
             NULL::text AS entry_status, NULL::bigint AS debit_minor
    ) ${alias(as)} ON TRUE`;
}

export interface StockJournalRule {
  /** `inv_stock_transactions.reference_type` of the document's movements. */
  referenceType: string;
  purpose: string;
  keyedOn: StockJournalKeying;
}

/**
 * Journals keyed under one of `rules` whose stock document has no movement at
 * all: a ledger that moved without the warehouse.
 *
 * Columns: journal_id, journal_number, journal_date (text), reference_type,
 * source_id, purpose, entry_status ('POSTED' | 'REVERSED'), debit_minor.
 */
export function orphanStockJournalsSql(params: {
  orgId: string;
  bookId: string;
  fromDate: string;
  toDate: string;
  limit: number;
  rules: readonly StockJournalRule[];
}): SQL {
  const rows = params.rules.map(
    (rule) => sql`(${rule.referenceType}::text, ${rule.purpose}::text, ${rule.keyedOn}::text)`,
  );
  return sql`
    WITH rules(reference_type, purpose, keyed_on) AS (VALUES ${sql.join(rows, sql`, `)})
    SELECT
      gj.id                    AS journal_id,
      gj.journal_number        AS journal_number,
      gj.journal_date::text    AS journal_date,
      r.reference_type         AS reference_type,
      gj.source_id             AS source_id,
      r.purpose                AS purpose,
      CASE WHEN gj.reversed_by_journal_id IS NOT NULL THEN 'REVERSED' ELSE 'POSTED' END AS entry_status,
      (
        SELECT COALESCE(SUM(jl.debit_minor), 0)
        FROM gl_journal_lines jl
        WHERE jl.journal_id = gj.id AND jl.org_id = gj.org_id
      )::bigint                AS debit_minor
    FROM gl_journals gj
    JOIN rules r ON gj.idempotency_key = 'stock_move:' || gj.source_id || ':' || r.purpose
    WHERE gj.org_id = ${params.orgId}
      AND gj.book_id = ${params.bookId}
      AND gj.source_type = 'stock_move'
      AND gj.source_id IS NOT NULL
      AND gj.journal_date BETWEEN ${params.fromDate}::date AND ${params.toDate}::date
      AND NOT EXISTS (
        SELECT 1 FROM inv_stock_transactions t
        WHERE t.org_id = gj.org_id
          AND t.reference_type = r.reference_type
          AND (
            (r.keyed_on = 'reference' AND t.reference_id = gj.source_id)
            OR
            (r.keyed_on = 'shipment' AND t.reference_id IN (
              SELECT s.so_id::text FROM inv_shipments s
              WHERE s.org_id = gj.org_id AND s.id::text = gj.source_id
            ))
          )
      )
    ORDER BY gj.journal_date DESC, gj.id DESC
    LIMIT ${params.limit}
  `;
}
