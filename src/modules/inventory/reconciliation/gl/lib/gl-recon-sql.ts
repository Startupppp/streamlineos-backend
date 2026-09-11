import { sql, type SQL } from "drizzle-orm";
import { POSTING_PURPOSE_BY_REFERENCE } from "../../../../accounting/adapters/reconciliation/unposted-movements.service";
import {
  noStockJournalsLateral,
  orphanStockJournalsSql,
  stockJournalsLateral,
} from "../../../../accounting/adapters/reconciliation/stock-journal-sql";
import { GL_POSTING_RULES, type ResolvedGlPostingRule } from "../gl-posting-rules";

export interface GlReconSqlParams {
  orgId: string;
  fromDate: string;
  toDate: string;
  /** Predicate over a location column, from `WarehouseScopeService`. */
  locationScope: (column: string) => SQL;
  warehouseId?: number;
  /**
   * The organisation's default `gl_books` row, or null when it has not enabled
   * accounting. With no book nothing was ever expected to post, so the
   * statements name no `gl_*` table at all and every group reads
   * `ACCOUNTING_NOT_INSTALLED`, rather than every movement reading `UNMATCHED`.
   */
  bookId: string | null;
  /**
   * INV-09 — the posting contract against *this organisation's* book, resolved
   * by the caller through the same system tags posting uses.
   */
  rules: readonly ResolvedGlPostingRule[];
  status?: string;
  limit: number;
  offset: number;
}

function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * The posting contract as a table, so the join is a join rather than a loop of
 * per-rule queries.
 */
function rulesCte(rules: readonly ResolvedGlPostingRule[]): SQL {
  const rows = rules.map(
    (rule) => sql`(
      ${rule.sourceType}::text,
      ${rule.sourceEvent}::text,
      ${rule.label}::text,
      ${rule.keyedOn}::text,
      ${textArray(rule.accountCodes)},
      ${textArray(rule.missingAccountTags)}
    )`,
  );
  return sql`rules(source_type, source_event, label, keyed_on, account_codes, missing_roles) AS (VALUES ${sql.join(rows, sql`, `)})`;
}

function warehouseFilter(orgId: string, column: string, warehouseId?: number): SQL {
  if (warehouseId == null) return sql`TRUE`;
  return sql`${sql.raw(column)} IN (
    SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId}
  )`;
}

/**
 * A minor-unit amount as a two-decimal major-unit string: the shape movement
 * values travel in, so both columns of a row read in the same unit. Hundredths,
 * the same convention every kernel-era inventory post uses.
 */
function asMajor(minor: SQL): SQL {
  return sql`((${minor})::numeric / 100)::numeric(20, 2)::text`;
}

/**
 * The journals a movement group produced, matched on the kernel's idempotency
 * key and aggregated to one row (`entry_id`, `entry_number`, `entry_date`,
 * `entry_status`, `debit_minor`). Accounting owns that SQL, because the ledger
 * boundary keeps ledger table names out of inventory. See
 * `accounting/adapters/reconciliation/stock-journal-sql.ts`.
 */
function journalLateral(orgId: string, bookId: string | null): SQL {
  if (bookId === null) return noStockJournalsLateral("j");
  return stockJournalsLateral(
    {
      orgId,
      bookId,
      referenceId: sql`m.reference_id`,
      purpose: sql`r.source_event`,
      keyedOn: sql`r.keyed_on`,
    },
    "j",
  );
}

/** Roles nothing fills; empty when there is no book, as nothing was expected. */
function missingRolesExpr(bookId: string | null): SQL {
  return bookId === null ? sql`ARRAY[]::text[]` : sql`r.missing_roles`;
}

/**
 * Four answers, in the order a reader needs them:
 *
 *   ACCOUNTING_NOT_INSTALLED  the organisation keeps no book; nothing was ever
 *                             expected, and saying "unmatched" would be a lie
 *   MISSING_COA               no journal, and a role the entry names has no
 *                             account in the book; the remedy is to tag one
 *   UNMATCHED                 no journal and no excuse: a real gap
 *   VALUE_MISMATCH            a journal exists and its debits, in minor units,
 *                             differ from what the movement cost, rounded to
 *                             minor units the way every post rounds it
 *
 * `VALUE_MISMATCH` is only claimed when the movement actually carries a cost.
 */
function statusCase(bookId: string | null): SQL {
  const enabled = bookId === null ? sql`FALSE` : sql`TRUE`;
  return sql`CASE
               WHEN ${enabled} = FALSE THEN 'ACCOUNTING_NOT_INSTALLED'
               WHEN j.entry_id IS NULL
                 AND COALESCE(array_length(${missingRolesExpr(bookId)}, 1), 0) > 0
                 THEN 'MISSING_COA'
               WHEN j.entry_id IS NULL THEN 'UNMATCHED'
               WHEN m.has_cost AND m.movement_value <> 0 AND j.debit_minor <> round(m.movement_value * 100)
                 THEN 'VALUE_MISMATCH'
               ELSE 'MATCHED'
             END`;
}

function movementsCte(params: Omit<GlReconSqlParams, "limit" | "offset" | "status">): SQL {
  const { orgId, fromDate, toDate, locationScope, warehouseId } = params;
  return sql`movements AS (
      SELECT t.reference_type,
             t.reference_id,
             MAX(COALESCE(t.posting_date, t.created_at::date))   AS posted_on,
             SUM(ABS(COALESCE(t.total_cost, 0)::numeric))        AS movement_value,
             SUM(t.quantity_change::numeric)                     AS net_quantity,
             count(*)                                            AS movement_count,
             bool_or(t.total_cost IS NOT NULL)                   AS has_cost
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.quantity_bucket = 'ON_HAND'
        AND t.reference_type IN (SELECT source_type FROM rules)
        AND t.reference_id IS NOT NULL
        AND ${locationScope("t.location_id")}
        AND ${warehouseFilter(orgId, "t.location_id", warehouseId)}
        AND COALESCE(t.posting_date, t.created_at::date) BETWEEN ${fromDate}::date AND ${toDate}::date
      GROUP BY t.reference_type, t.reference_id
    )`;
}

/**
 * D6 — one inventory movement group against the journals the kernel holds for
 * it.
 *
 * The grain is `(reference_type, reference_id)`: a goods receipt writes one
 * ledger row per line and produces exactly one journal, so comparing row for
 * row would report a dozen unmatched movements for one posted document.
 */
export function glReconRowsSql(params: GlReconSqlParams): SQL {
  const { orgId, bookId, rules } = params;
  const statusFilter =
    params.status == null ? sql`TRUE` : sql`classified.status = ${params.status}`;

  return sql`
    WITH ${rulesCte(rules)},
    ${movementsCte(params)},
    classified AS (
      SELECT m.reference_type,
             m.reference_id,
             m.posted_on,
             m.movement_value,
             m.net_quantity,
             m.movement_count,
             m.has_cost,
             r.source_event,
             r.label,
             r.account_codes,
             ${missingRolesExpr(bookId)} AS missing_roles,
             j.entry_id,
             j.entry_number,
             j.entry_date,
             j.entry_status,
             j.debit_minor,
             ${statusCase(bookId)} AS status
      FROM movements m
      JOIN rules r ON r.source_type = m.reference_type
      ${journalLateral(orgId, bookId)}
    )
    SELECT
      classified.reference_type                    AS "sourceType",
      classified.reference_id                      AS "sourceId",
      classified.label                             AS "label",
      classified.source_event                      AS "sourceEvent",
      classified.posted_on::text                   AS "postedOn",
      classified.movement_value::text              AS "movementValue",
      classified.net_quantity::text                AS "netQuantity",
      classified.movement_count::int               AS "movementCount",
      classified.has_cost                          AS "hasCost",
      classified.account_codes                     AS "accountCodes",
      classified.missing_roles                     AS "missingAccountCodes",
      classified.entry_id                          AS "journalEntryId",
      classified.entry_number                      AS "journalEntryNumber",
      classified.entry_date::text                  AS "journalEntryDate",
      classified.entry_status                      AS "journalStatus",
      ${asMajor(sql`classified.debit_minor`)}      AS "journalValue",
      classified.status                            AS "status",
      count(*) OVER ()::int                        AS "totalRows"
    FROM classified
    WHERE ${statusFilter}
    ORDER BY classified.posted_on DESC, classified.reference_type, classified.reference_id
    LIMIT ${params.limit} OFFSET ${params.offset}
  `;
}

/**
 * The same classification, counted across the whole window rather than the page.
 * A summary taken from one page of fifty would describe the page, and the first
 * question anyone asks a reconciliation is how much of the period is green.
 */
export function glReconSummarySql(params: Omit<GlReconSqlParams, "limit" | "offset" | "status">): SQL {
  const { orgId, bookId, rules } = params;

  return sql`
    WITH ${rulesCte(rules)},
    ${movementsCte(params)},
    classified AS (
      SELECT m.movement_value,
             j.debit_minor,
             ${statusCase(bookId)} AS status
      FROM movements m
      JOIN rules r ON r.source_type = m.reference_type
      ${journalLateral(orgId, bookId)}
    )
    SELECT
      count(*)::int                                                     AS "groups",
      count(*) FILTER (WHERE status = 'MATCHED')::int                   AS "matched",
      count(*) FILTER (WHERE status = 'VALUE_MISMATCH')::int            AS "valueMismatch",
      count(*) FILTER (WHERE status = 'MISSING_COA')::int               AS "missingCoa",
      count(*) FILTER (WHERE status = 'UNMATCHED')::int                 AS "unmatched",
      count(*) FILTER (WHERE status = 'ACCOUNTING_NOT_INSTALLED')::int  AS "notInstalled",
      COALESCE(SUM(movement_value), 0)::text                            AS "movementValue",
      ${asMajor(sql`COALESCE(SUM(debit_minor), 0)`)}                    AS "journalValue",
      COALESCE(SUM(movement_value) FILTER (WHERE status <> 'MATCHED'), 0)::text AS "unreconciledValue"
    FROM classified
  `;
}

/**
 * Reference types `StockMovementBridgeService` posts per document kind:
 * adjustments, transfers, counts, quality scrap and both returns. They come
 * from the accounting module's own list, so this report and that one cannot
 * disagree about which movements have a posting path.
 */
export function stockBridgeReferenceTypes(): string[] {
  return Object.keys(POSTING_PURPOSE_BY_REFERENCE).filter(
    (reference) => !GL_POSTING_RULES.some((rule) => rule.sourceType === reference),
  );
}

/**
 * What moved in the window that no rule here covers, grouped by reference type.
 *
 * Each group says whether the accounting module's stock bridge posts it
 * (`postedByStockBridge`). Those groups are reconciled per document in
 * Accounting → Reconciliation, and calling them "never posted" would now be
 * false. The rest are movements nothing posts: quarantines, reservations,
 * opening stock, and the inventory-only movers that have no document kind yet.
 * Reporting them nowhere would leave a green reconciliation looking like the
 * stock ledger and the general ledger agree, which is a larger claim than it
 * can make.
 */
export function glUnpostedByDesignSql(
  params: Omit<GlReconSqlParams, "limit" | "offset" | "status" | "bookId" | "rules">,
): SQL {
  const { orgId, fromDate, toDate, locationScope, warehouseId } = params;
  const covered = sql.join(
    GL_POSTING_RULES.map((rule) => sql`${rule.sourceType}`),
    sql`, `,
  );
  const bridged = sql.join(
    stockBridgeReferenceTypes().map((reference) => sql`${reference}`),
    sql`, `,
  );
  return sql`
    SELECT
      COALESCE(t.reference_type, 'none')::text     AS "sourceType",
      count(*)::int                                AS "movementCount",
      SUM(ABS(COALESCE(t.total_cost, 0)::numeric))::text AS "movementValue",
      COALESCE(bool_or(t.reference_type IN (${bridged})), FALSE) AS "postedByStockBridge"
    FROM inv_stock_transactions t
    WHERE t.org_id = ${orgId}
      AND t.quantity_bucket = 'ON_HAND'
      AND (t.reference_type IS NULL OR t.reference_type NOT IN (${covered}))
      AND ${locationScope("t.location_id")}
      AND ${warehouseFilter(orgId, "t.location_id", warehouseId)}
      AND COALESCE(t.posting_date, t.created_at::date) BETWEEN ${fromDate}::date AND ${toDate}::date
    GROUP BY COALESCE(t.reference_type, 'none')
    ORDER BY 2 DESC
    LIMIT 20
  `;
}

/**
 * The other direction: a journal a rule here names whose document has no stock
 * movement at all. A journal with no movement is a ledger that moved without
 * the warehouse, which is the failure this report exists to catch. Landed-cost
 * journals always appear here, because a voucher revalues layers and moves no
 * stock, as they did in the legacy report. Accounting owns the ledger read.
 */
export function glOrphanJournalsSql(params: {
  orgId: string;
  bookId: string;
  fromDate: string;
  toDate: string;
  limit: number;
}): SQL {
  const orphans = orphanStockJournalsSql({
    ...params,
    rules: GL_POSTING_RULES.map((rule) => ({
      referenceType: rule.sourceType,
      purpose: rule.sourceEvent,
      keyedOn: rule.keyedOn,
    })),
  });
  return sql`
    SELECT
      o.journal_id                      AS "journalEntryId",
      o.journal_number                  AS "journalEntryNumber",
      o.journal_date                    AS "journalEntryDate",
      o.reference_type                  AS "sourceType",
      o.source_id                       AS "sourceId",
      o.purpose                         AS "sourceEvent",
      o.entry_status                    AS "journalStatus",
      ${asMajor(sql`o.debit_minor`)}    AS "journalValue"
    FROM (${orphans}) o
    ORDER BY o.journal_date DESC, o.journal_id DESC
  `;
}
