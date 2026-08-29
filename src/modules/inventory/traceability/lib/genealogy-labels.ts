import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";

/**
 * D1. Document nodes carry a business number, not a row id.
 *
 * "Show names, never raw IDs" applies to a graph as much as to a table, and a
 * recall trace that says `inv_grn:41` is unusable to the person holding the
 * paperwork. Each lookup is a single `IN` over ids the walk already bounded to
 * `maxNodes`, so this adds a fixed handful of small queries, never a per-node
 * one.
 */
const DOCUMENT_SOURCES: Record<string, { table: string; column: string }> = {
  inv_grn: { table: "inv_grns", column: "grn_number" },
  inv_sales_order: { table: "inv_sales_orders", column: "so_number" },
  inv_transfer: { table: "inv_stock_transfers", column: "reference_number" },
  inv_adjustment: { table: "inv_stock_adjustments", column: "reference_number" },
  inv_customer_return: { table: "inv_customer_returns", column: "return_number" },
  inv_vendor_return: { table: "inv_vendor_returns", column: "return_number" },
};

const TYPE_LABELS: Record<string, string> = {
  inv_grn: "Receipt",
  inv_sales_order: "Sales order",
  inv_transfer: "Transfer",
  inv_adjustment: "Adjustment",
  inv_customer_return: "Customer return",
  inv_vendor_return: "Vendor return",
  inv_cycle_count: "Cycle count",
  inv_physical_audit: "Physical audit",
  inv_putaway_task: "Putaway",
  reversal: "Correction of movement",
  RECALL: "Recall",
  QUALITY_HOLD: "Quality hold",
  QUALITY_HOLD_RELEASE: "Quality release",
  IMPORT: "Import",
  opening_balance: "Opening balance",
};

export function documentFallbackLabel(referenceType: string, referenceId: string): string {
  return `${TYPE_LABELS[referenceType] ?? referenceType} #${referenceId}`;
}

/**
 * Business numbers for every document node in one answer, keyed
 * `<referenceType>:<referenceId>`. Unknown or unresolvable references simply
 * keep their fallback label — a missing number is not an error.
 */
export async function resolveDocumentLabels(
  db: Db,
  orgId: string,
  references: ReadonlyArray<{ referenceType: string; referenceId: string }>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const byType = new Map<string, number[]>();

  for (const ref of references) {
    const source = DOCUMENT_SOURCES[ref.referenceType];
    if (!source) continue;
    const numericId = Number(ref.referenceId);
    if (!Number.isInteger(numericId) || numericId <= 0) continue;
    const bucket = byType.get(ref.referenceType);
    if (bucket) bucket.push(numericId);
    else byType.set(ref.referenceType, [numericId]);
  }

  await Promise.all(
    [...byType].map(async ([referenceType, ids]) => {
      const source = DOCUMENT_SOURCES[referenceType];
      if (!source) return;
      const rows = await db.execute<{ id: number; label: string | null }>(sql`
        SELECT id, ${sql.raw(`"${source.column}"`)} AS label
        FROM ${sql.raw(`"${source.table}"`)}
        WHERE org_id = ${orgId}
          AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      for (const row of rows) {
        if (row.label) labels.set(`${referenceType}:${String(row.id)}`, row.label);
      }
    }),
  );

  return labels;
}

/** Lot numbers for every lot node in one answer, keyed by lot id. */
export async function resolveLotLabels(
  db: Db,
  orgId: string,
  lotIds: readonly number[],
): Promise<Map<number, string>> {
  if (lotIds.length === 0) return new Map();
  const rows = await db.execute<{ id: number; lot_number: string }>(sql`
    SELECT id, lot_number FROM inv_lots
    WHERE org_id = ${orgId}
      AND id IN (${sql.join(lotIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rows.map((row) => [row.id, row.lot_number]));
}

/** Serial numbers for every serial node in one answer, keyed by serial id. */
export async function resolveSerialLabels(
  db: Db,
  orgId: string,
  serialIds: readonly number[],
): Promise<Map<number, string>> {
  if (serialIds.length === 0) return new Map();
  const rows = await db.execute<{ id: number; serial_number: string }>(sql`
    SELECT id, serial_number FROM inv_serial_numbers
    WHERE org_id = ${orgId}
      AND id IN (${sql.join(serialIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(rows.map((row) => [row.id, row.serial_number]));
}
