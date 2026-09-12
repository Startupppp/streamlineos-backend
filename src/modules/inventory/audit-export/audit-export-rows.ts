import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  AUDIT_EVENT_COLUMNS,
  LEDGER_COLUMNS,
  type AuditExportSection,
} from "./audit-export-document";

/**
 * Every column is read as `text` so the bytes that go into the checksum are
 * Postgres's own rendering of what it stores. A `numeric(18,4)` arrives as
 * `'5.0000'` and is written through untouched; `parseFloat` on it would round
 * the evidence, and `Number()` would drop the trailing zeros that make two
 * renderings of the same quantity compare equal as text.
 */
type TextRow = readonly (string | null)[];

export interface EvidencePin {
  /** `xid8` as a decimal string — the boundary the ceilings were read at. */
  pinnedXmax: string;
  ledgerCeilingId: number;
  auditCeilingId: number;
}

/**
 * The ledger alias every query in this file uses. The warehouse-scope predicate
 * is built elsewhere and has to target the same alias, so it is named here
 * rather than spelled out at the call site.
 */
export const LEDGER_LOCATION_COLUMN: SQL = sql`t.location_id`;

export interface AuditExportWindow {
  orgId: string;
  from: string | null;
  to: string | null;
  ledgerCeilingId: number;
  auditCeilingId: number;
  /** Warehouse-scope predicate over `t.location_id`; `TRUE` when unrestricted. */
  locationScope: SQL;
}

const AUDIT_EVENT_EXPRESSIONS: Readonly<Record<string, string>> = {
  before_sha256: "encode(sha256(convert_to(a.before::text, 'UTF8')), 'hex')",
  after_sha256: "encode(sha256(convert_to(a.after::text, 'UTF8')), 'hex')",
  metadata_sha256: "encode(sha256(convert_to(a.metadata::text, 'UTF8')), 'hex')",
};

/**
 * Built from the same constants the encoder declares its column order from, so
 * the SQL projection and the document's `columns` array cannot drift apart.
 */
const LEDGER_PROJECTION = sql.raw(
  LEDGER_COLUMNS.map((column) => `t.${column}::text AS ${column}`).join(", "),
);

const AUDIT_EVENT_PROJECTION = sql.raw(
  AUDIT_EVENT_COLUMNS.map(
    (column) => `${AUDIT_EVENT_EXPRESSIONS[column] ?? `a.${column}::text`} AS ${column}`,
  ).join(", "),
);

function createdAtFilter(column: SQL, from: string | null, to: string | null): SQL {
  const parts: SQL[] = [];
  if (from) parts.push(sql`${column} >= ${from}::date`);
  if (to) parts.push(sql`${column} < (${to}::date + 1)`);
  if (parts.length === 0) return sql`TRUE`;
  return sql.join(parts, sql` AND `);
}

function textValues(row: Record<string, unknown>, columns: readonly string[], relation: string): TextRow {
  return columns.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    throw new Error(`${relation}.${column} did not come back as text; got ${typeof value}`);
  });
}

/**
 * Reads the evidence ceilings and the transaction-id boundary in one statement,
 * so both describe the same snapshot. Read apart, a row could commit between
 * them and sit below a ceiling that was taken before it existed.
 *
 * The boundary is NOT `pg_snapshot_xmax` on its own. A snapshot's xmax is
 * `latestCompletedXid + 1`, so a transaction that is still running can hold an
 * xid equal to or greater than it — measured: a session that had already
 * inserted came back with an xid exactly equal to the xmax a second session
 * then pinned. `isEvidenceSettled` compares that boundary against xmin, so with
 * that writer as the only transaction in flight xmin equalled the boundary and
 * the pin was called settled while the row below the ceiling could still
 * commit. `pg_current_xact_id()` assigns this transaction an id, which is
 * strictly greater than every id assigned before now — and an id assigned
 * before now is the only kind a dangerous writer can hold, because `nextval`
 * runs at INSERT and anything inserting later lands above the ceiling.
 */
export async function pinEvidence(db: Db, orgId: string): Promise<EvidencePin> {
  const rows = await db.execute(sql`
    SELECT
      GREATEST(
        pg_current_xact_id()::text::numeric,
        pg_snapshot_xmax(pg_current_snapshot())::text::numeric
      )::text AS pinned_xmax,
      (SELECT coalesce(max(id), 0) FROM inv_stock_transactions WHERE org_id = ${orgId})::text AS ledger_ceiling,
      (SELECT coalesce(max(id), 0) FROM inv_audit_events WHERE org_id = ${orgId})::text AS audit_ceiling
  `);
  const row = rows[0];
  if (!row) throw new Error("audit export: could not pin an evidence version");
  return {
    pinnedXmax: String(row["pinned_xmax"]),
    ledgerCeilingId: Number(row["ledger_ceiling"]),
    auditCeilingId: Number(row["audit_ceiling"]),
  };
}

/**
 * True once every transaction that was in flight when the pin was taken has
 * ended. `serial` allocates ids outside transaction control, so before this
 * point a row with an id below the ceiling can still commit and join the set;
 * after it, the set at or below the ceiling is final and a checksum over it is
 * reproducible forever.
 *
 * Conservative in one direction only, and deliberately: a snapshot is
 * cluster-wide, so an unrelated long transaction in another database holds xmin
 * down and this reports "not settled" for longer than it needs to. It never
 * reports settled early — which is the direction that would corrupt an export.
 */
export async function isEvidenceSettled(db: Db, pinnedXmax: string): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text::numeric >= ${pinnedXmax}::numeric AS settled`,
  );
  return rows[0]?.["settled"] === true;
}

export async function countSection(
  db: Db,
  section: AuditExportSection,
  window: AuditExportWindow,
): Promise<number> {
  const rows =
    section === "ledger"
      ? await db.execute(sql`
          SELECT count(*)::text AS n
          FROM inv_stock_transactions t
          WHERE t.org_id = ${window.orgId}
            AND t.id <= ${window.ledgerCeilingId}
            AND ${createdAtFilter(sql`t.created_at`, window.from, window.to)}
            AND ${window.locationScope}
        `)
      : await db.execute(sql`
          SELECT count(*)::text AS n
          FROM inv_audit_events a
          WHERE a.org_id = ${window.orgId}
            AND a.id <= ${window.auditCeilingId}
            AND ${createdAtFilter(sql`a.created_at`, window.from, window.to)}
        `);
  return Number(rows[0]?.["n"] ?? 0);
}

/**
 * Keyset pagination on the primary key. `(org_id, id)` is unique, so `id ASC`
 * is a total order within a tenant and the same rows come back in the same
 * order on every run — which is the whole point. No `OFFSET`, and never the
 * whole history in memory.
 */
export async function* readSection(
  db: Db,
  section: AuditExportSection,
  window: AuditExportWindow,
  chunkSize: number,
): AsyncGenerator<TextRow> {
  let cursor = 0;
  for (;;) {
    const rows =
      section === "ledger"
        ? await db.execute(sql`
            SELECT ${LEDGER_PROJECTION}
            FROM inv_stock_transactions t
            WHERE t.org_id = ${window.orgId}
              AND t.id > ${cursor}
              AND t.id <= ${window.ledgerCeilingId}
              AND ${createdAtFilter(sql`t.created_at`, window.from, window.to)}
              AND ${window.locationScope}
            ORDER BY t.id ASC
            LIMIT ${chunkSize}
          `)
        : await db.execute(sql`
            SELECT ${AUDIT_EVENT_PROJECTION}
            FROM inv_audit_events a
            WHERE a.org_id = ${window.orgId}
              AND a.id > ${cursor}
              AND a.id <= ${window.auditCeilingId}
              AND ${createdAtFilter(sql`a.created_at`, window.from, window.to)}
            ORDER BY a.id ASC
            LIMIT ${chunkSize}
          `);

    const batch: Record<string, unknown>[] = Array.from(rows);
    if (batch.length === 0) return;

    const columns = section === "ledger" ? LEDGER_COLUMNS : AUDIT_EVENT_COLUMNS;
    const relation = section === "ledger" ? "inv_stock_transactions" : "inv_audit_events";
    for (const row of batch) yield textValues(row, columns, relation);

    const last = batch[batch.length - 1];
    const lastId = Number(last?.["id"]);
    if (!Number.isFinite(lastId) || lastId <= cursor) return;
    cursor = lastId;
    if (batch.length < chunkSize) return;
  }
}
