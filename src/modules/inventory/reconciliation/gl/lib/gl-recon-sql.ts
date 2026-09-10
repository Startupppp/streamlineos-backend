import { sql, type SQL } from "drizzle-orm";
import { GL_POSTING_RULES, type ResolvedGlPostingRule } from "../gl-posting-rules";

export interface GlReconSqlParams {
  orgId: string;
  fromDate: string;
  toDate: string;
  /** Predicate over a location column, from `WarehouseScopeService`. */
  locationScope: (column: string) => SQL;
  warehouseId?: number;
  /** False when `journal_entries` is absent from this database. */
  journalsInstalled: boolean;
  /**
   * INV-09 — the posting contract as *this organisation's* account codes.
   *
   * Passed in rather than read from `GL_POSTING_RULES` here, because the rules
   * are stated in system-account purposes and only the caller has resolved them
   * against `acc_system_account_map`. A tenant that has mapped INVENTORY_ASSET
   * to its own account posts there, so the report's expectation has to look
   * there too or every receipt reads MISSING_COA.
   */
  rules: readonly ResolvedGlPostingRule[];
  status?: string;
  limit: number;
  offset: number;
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
      ARRAY[${sql.join(rule.accountCodes.map((code) => sql`${code}`), sql`, `)}]::text[]
    )`,
  );
  return sql`rules(source_type, source_event, label, account_codes) AS (VALUES ${sql.join(rows, sql`, `)})`;
}

function warehouseFilter(orgId: string, column: string, warehouseId?: number): SQL {
  if (warehouseId == null) return sql`TRUE`;
  return sql`${sql.raw(column)} IN (
    SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId}
  )`;
}

/**
 * Both halves of the report reference `journal_entries` and `ledger_accounts`,
 * and those tables do not exist in every database — the whole reason
 * `InventoryAccountingBridge` probes with `to_regclass`. Postgres resolves table
 * names at plan time, not at run time, so a runtime flag cannot switch them off:
 * the reference has to be absent from the statement text. These two fragments
 * are how.
 */
function journalLateral(orgId: string, installed: boolean): SQL {
  if (!installed)
    return sql`
      LEFT JOIN LATERAL (
        SELECT NULL::int AS entry_id, NULL::text AS entry_number, NULL::date AS entry_date,
               NULL::text AS entry_status, NULL::numeric AS debit_total
      ) j ON TRUE`;
  return sql`
    LEFT JOIN LATERAL (
      SELECT je.id AS entry_id,
             je.entry_number,
             je.entry_date,
             je.status::text AS entry_status,
             (
               SELECT COALESCE(SUM(jl.debit::numeric), 0)
               FROM journal_lines jl
               WHERE jl.entry_id = je.id AND jl.org_id = je.org_id
             ) AS debit_total
      FROM journal_entries je
      WHERE je.org_id = ${orgId}
        AND je.source_type = m.reference_type
        AND je.source_id = m.reference_id
        AND je.source_event = r.source_event
      ORDER BY je.id DESC
      LIMIT 1
    ) j ON TRUE`;
}

function missingCodesExpr(orgId: string, installed: boolean): SQL {
  if (!installed) return sql`ARRAY[]::text[]`;
  return sql`ARRAY(
    SELECT code FROM unnest(r.account_codes) AS t(code)
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_accounts la
      WHERE la.org_id = ${orgId} AND la.code = t.code
    )
  )`;
}

/**
 * D6 — one inventory movement group against the journal the bridge posted for
 * it.
 *
 * The grain is `(reference_type, reference_id)`: a goods receipt writes one
 * ledger row per line and produces exactly one journal entry, so comparing row
 * for row would report a dozen unmatched movements for one posted document. The
 * group is what the bridge posts against, so the group is what reconciles.
 *
 * Four answers, in the order a reader needs them:
 *
 *   ACCOUNTING_NOT_INSTALLED  the module is not migrated here; nothing was ever
 *                             expected, and saying "unmatched" would be a lie
 *   MISSING_COA               no journal, and the tenant has no ledger account
 *                             for a code the entry names — the bridge's honest
 *                             skip, with the codes to go and create
 *   UNMATCHED                 no journal and no excuse: a real gap
 *   VALUE_MISMATCH            a journal exists and its debits do not equal what
 *                             the movement cost
 *
 * `VALUE_MISMATCH` is only claimed when the movement actually carries a cost.
 * Plenty of ledger rows do not — a transfer, an adjustment with no unit cost —
 * and comparing a journal against a null would manufacture a discrepancy out of
 * a missing input.
 */
export function glReconRowsSql(params: GlReconSqlParams): SQL {
  const { orgId, fromDate, toDate, locationScope, warehouseId, journalsInstalled, rules } = params;
  const installedFlag = journalsInstalled ? sql`TRUE` : sql`FALSE`;
  const statusFilter =
    params.status == null ? sql`TRUE` : sql`classified.status = ${params.status}`;

  return sql`
    WITH ${rulesCte(rules)},
    movements AS (
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
    ),
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
             ${missingCodesExpr(orgId, journalsInstalled)} AS missing_codes,
             j.entry_id,
             j.entry_number,
             j.entry_date,
             j.entry_status,
             j.debit_total,
             CASE
               WHEN ${installedFlag} = FALSE THEN 'ACCOUNTING_NOT_INSTALLED'
               WHEN j.entry_id IS NULL
                 AND COALESCE(array_length(${missingCodesExpr(orgId, journalsInstalled)}, 1), 0) > 0
                 THEN 'MISSING_COA'
               WHEN j.entry_id IS NULL THEN 'UNMATCHED'
               WHEN m.has_cost AND m.movement_value <> 0 AND j.debit_total <> m.movement_value
                 THEN 'VALUE_MISMATCH'
               ELSE 'MATCHED'
             END AS status
      FROM movements m
      JOIN rules r ON r.source_type = m.reference_type
      ${journalLateral(orgId, journalsInstalled)}
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
      classified.missing_codes                     AS "missingAccountCodes",
      classified.entry_id                          AS "journalEntryId",
      classified.entry_number                      AS "journalEntryNumber",
      classified.entry_date::text                  AS "journalEntryDate",
      classified.entry_status                      AS "journalStatus",
      classified.debit_total::text                 AS "journalValue",
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
  const { orgId, fromDate, toDate, locationScope, warehouseId, journalsInstalled, rules } = params;
  const installedFlag = journalsInstalled ? sql`TRUE` : sql`FALSE`;

  return sql`
    WITH ${rulesCte(rules)},
    movements AS (
      SELECT t.reference_type,
             t.reference_id,
             SUM(ABS(COALESCE(t.total_cost, 0)::numeric)) AS movement_value,
             bool_or(t.total_cost IS NOT NULL)            AS has_cost
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.quantity_bucket = 'ON_HAND'
        AND t.reference_type IN (SELECT source_type FROM rules)
        AND t.reference_id IS NOT NULL
        AND ${locationScope("t.location_id")}
        AND ${warehouseFilter(orgId, "t.location_id", warehouseId)}
        AND COALESCE(t.posting_date, t.created_at::date) BETWEEN ${fromDate}::date AND ${toDate}::date
      GROUP BY t.reference_type, t.reference_id
    ),
    classified AS (
      SELECT m.movement_value,
             j.debit_total,
             CASE
               WHEN ${installedFlag} = FALSE THEN 'ACCOUNTING_NOT_INSTALLED'
               WHEN j.entry_id IS NULL
                 AND COALESCE(array_length(${missingCodesExpr(orgId, journalsInstalled)}, 1), 0) > 0
                 THEN 'MISSING_COA'
               WHEN j.entry_id IS NULL THEN 'UNMATCHED'
               WHEN m.has_cost AND m.movement_value <> 0 AND j.debit_total <> m.movement_value
                 THEN 'VALUE_MISMATCH'
               ELSE 'MATCHED'
             END AS status
      FROM movements m
      JOIN rules r ON r.source_type = m.reference_type
      ${journalLateral(orgId, journalsInstalled)}
    )
    SELECT
      count(*)::int                                                     AS "groups",
      count(*) FILTER (WHERE status = 'MATCHED')::int                   AS "matched",
      count(*) FILTER (WHERE status = 'VALUE_MISMATCH')::int            AS "valueMismatch",
      count(*) FILTER (WHERE status = 'MISSING_COA')::int               AS "missingCoa",
      count(*) FILTER (WHERE status = 'UNMATCHED')::int                 AS "unmatched",
      count(*) FILTER (WHERE status = 'ACCOUNTING_NOT_INSTALLED')::int  AS "notInstalled",
      COALESCE(SUM(movement_value), 0)::text                            AS "movementValue",
      COALESCE(SUM(debit_total), 0)::text                               AS "journalValue",
      COALESCE(SUM(movement_value) FILTER (WHERE status <> 'MATCHED'), 0)::text AS "unreconciledValue"
    FROM classified
  `;
}

/**
 * What moved in the window that no posting rule covers — transfers, adjustments,
 * cycle counts, write-offs. None of them produce a journal today, and reporting
 * them as unmatched would be inventing an expectation nobody has. Reporting them
 * nowhere would leave the reader thinking a green reconciliation means stock and
 * the ledger agree, which is a different and larger claim.
 */
export function glUnpostedByDesignSql(params: Omit<GlReconSqlParams, "limit" | "offset" | "status" | "journalsInstalled" | "rules">): SQL {
  const { orgId, fromDate, toDate, locationScope, warehouseId } = params;
  const covered = sql.join(
    GL_POSTING_RULES.map((rule) => sql`${rule.sourceType}`),
    sql`, `,
  );
  return sql`
    SELECT
      COALESCE(t.reference_type, 'none')::text     AS "sourceType",
      count(*)::int                                AS "movementCount",
      SUM(ABS(COALESCE(t.total_cost, 0)::numeric))::text AS "movementValue"
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
 * The other direction: a journal the bridge posted whose document has no stock
 * movement in the window. Usually a movement that fell outside the dates, but a
 * journal with no movement at all is a ledger that has moved without the
 * warehouse, which is the failure this report exists to catch.
 */
export function glOrphanJournalsSql(params: {
  orgId: string;
  fromDate: string;
  toDate: string;
  limit: number;
}): SQL {
  const sourceTypes = sql.join(
    GL_POSTING_RULES.map((rule) => sql`${rule.sourceType}`),
    sql`, `,
  );
  const events = sql.join(
    GL_POSTING_RULES.map((rule) => sql`${rule.sourceEvent}`),
    sql`, `,
  );
  return sql`
    SELECT
      je.id                    AS "journalEntryId",
      je.entry_number          AS "journalEntryNumber",
      je.entry_date::text      AS "journalEntryDate",
      je.source_type           AS "sourceType",
      je.source_id             AS "sourceId",
      je.source_event          AS "sourceEvent",
      je.status::text          AS "journalStatus",
      (
        SELECT COALESCE(SUM(jl.debit::numeric), 0)
        FROM journal_lines jl
        WHERE jl.entry_id = je.id AND jl.org_id = je.org_id
      )::text                  AS "journalValue"
    FROM journal_entries je
    WHERE je.org_id = ${params.orgId}
      AND je.source_type IN (${sourceTypes})
      AND je.source_event IN (${events})
      AND je.entry_date BETWEEN ${params.fromDate}::date AND ${params.toDate}::date
      AND NOT EXISTS (
        SELECT 1 FROM inv_stock_transactions t
        WHERE t.org_id = je.org_id
          AND t.reference_type = je.source_type
          AND t.reference_id = je.source_id
      )
    ORDER BY je.entry_date DESC, je.id DESC
    LIMIT ${params.limit}
  `;
}
