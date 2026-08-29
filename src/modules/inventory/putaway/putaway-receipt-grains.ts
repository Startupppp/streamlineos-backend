import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

/** One (variant, lot, serial) grain a receipt landed, and where it must go. */
export interface ReceiptGrain {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
  /** Decimal string at scale 4, straight off the ledger. */
  quantity: string;
  disposition: "STORAGE" | "QUARANTINE";
}

interface GrainKeyed {
  productVariantId: number;
  lotId: number | null;
  serialId: number | null;
}

/**
 * Does this quality record cover this grain?
 *
 * A null lot or serial on the *record* means "whichever", because that is what
 * it means where those records are written: a hold raised against a variant at a
 * location holds everything standing there. A null on the *grain* is the
 * untracked case and only a record that is equally unspecific covers it. Exact
 * matching in both directions would have let a hold on a variant fail to catch
 * the lots it was raised over.
 */
function covers(record: GrainKeyed, grain: GrainKeyed): boolean {
  if (record.productVariantId !== grain.productVariantId) return false;
  if (record.lotId !== null && record.lotId !== grain.lotId) return false;
  if (record.serialId !== null && record.serialId !== grain.serialId) return false;
  return true;
}

function toGrain(row: {
  product_variant_id: number;
  lot_id: number | null;
  serial_id: number | null;
}): GrainKeyed {
  return {
    productVariantId: Number(row.product_variant_id),
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    serialId: row.serial_id === null ? null : Number(row.serial_id),
  };
}

/**
 * B3 — what a posted goods receipt actually put on the floor.
 *
 * Read from the ledger rather than recomputed from the receipt's lines, and the
 * difference matters three times over. A rejected line posts no movement at all,
 * so re-deriving from `inv_grn_lines` would raise a putaway task for goods the
 * warehouse refused. A serial-tracked line posts one movement per unit, each
 * with its own `serial_id`, which the receipt line does not carry. And a
 * reversed receipt has compensating rows, so the sum is zero and the task is
 * empty — which is the correct answer, rather than a walk for stock that has
 * been unwound.
 *
 * Grouped at the projection's own grain, because that is the grain a movement
 * has to name: a line keyed on the variant alone cannot send two lots of one SKU
 * to two bins.
 */
export async function readReceiptGrains(
  tx: DbOrTx,
  orgId: string,
  grnId: number,
  fromLocationId: number,
): Promise<ReceiptGrain[]> {
  const rows = await tx.execute<{
    product_variant_id: number;
    lot_id: number | null;
    serial_id: number | null;
    quantity: string;
  }>(sql`
    SELECT t.product_variant_id,
           t.lot_id,
           t.serial_id,
           SUM(t.quantity_change)::text AS quantity
      FROM inv_stock_transactions t
     WHERE t.org_id = ${orgId}
       AND t.reference_type = 'inv_grn'
       AND t.reference_id = ${String(grnId)}
       AND t.quantity_bucket = 'ON_HAND'
       AND t.location_id = ${fromLocationId}
     GROUP BY t.product_variant_id, t.lot_id, t.serial_id
    HAVING SUM(t.quantity_change) > 0
     ORDER BY t.product_variant_id, t.lot_id, t.serial_id
  `);

  const quarantined = await quarantinedGrains(tx, orgId, grnId, fromLocationId);

  return rows.map((row) => {
    const grain = {
      productVariantId: Number(row.product_variant_id),
      lotId: row.lot_id === null ? null : Number(row.lot_id),
      serialId: row.serial_id === null ? null : Number(row.serial_id),
    };
    return {
      ...grain,
      quantity: row.quantity,
      disposition: quarantined(grain) ? ("QUARANTINE" as const) : ("STORAGE" as const),
    };
  });
}

/**
 * B3, item 2 — which grains may not go on a storage shelf.
 *
 * Two independent reasons, and both are read rather than asked for. Quarantine
 * is not a preference an operator expresses at the bin; it is a fact about the
 * goods that the putaway has to honour.
 *
 *   A **failed inspection on this receipt**. `fail` moves an inspection to
 *   DISPOSITION_REQUIRED and `dispose` can leave it there for a while, so both
 *   states count. An inspection raised by `inspectionOnReceipt` carries no lines
 *   at all — the setting creates a header against the whole delivery — so a
 *   line-less failure quarantines the whole receipt, and a lined one quarantines
 *   exactly the grains its lines name. Matching lines only would have made the
 *   common case a silent no-op.
 *
 *   An **active quality hold** covering the grain where it is standing. A hold
 *   with no location is org-wide on that grain and counts too.
 */
async function quarantinedGrains(
  tx: DbOrTx,
  orgId: string,
  grnId: number,
  fromLocationId: number,
): Promise<(grain: GrainKeyed) => boolean> {
  const [failure] = await tx.execute<{ failed: boolean; lined: boolean }>(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM inv_quality_inspections i
         WHERE i.org_id = ${orgId}
           AND i.source_type = 'inv_grn'
           AND i.source_id = ${String(grnId)}
           AND i.status IN ('FAILED', 'DISPOSITION_REQUIRED')
      ) AS failed,
      EXISTS (
        SELECT 1
          FROM inv_quality_inspection_lines l
          JOIN inv_quality_inspections i
            ON i.org_id = l.org_id AND i.id = l.inspection_id
         WHERE i.org_id = ${orgId}
           AND i.source_type = 'inv_grn'
           AND i.source_id = ${String(grnId)}
           AND i.status IN ('FAILED', 'DISPOSITION_REQUIRED')
      ) AS lined
  `);

  const inspectionFailed = failure?.failed === true;
  const inspectionHasLines = failure?.lined === true;

  const named: GrainKeyed[] = [];

  if (inspectionFailed && inspectionHasLines) {
    const lines = await tx.execute<{
      product_variant_id: number;
      lot_id: number | null;
      serial_id: number | null;
    }>(sql`
      SELECT l.product_variant_id, l.lot_id, l.serial_id
        FROM inv_quality_inspection_lines l
        JOIN inv_quality_inspections i
          ON i.org_id = l.org_id AND i.id = l.inspection_id
       WHERE i.org_id = ${orgId}
         AND i.source_type = 'inv_grn'
         AND i.source_id = ${String(grnId)}
         AND i.status IN ('FAILED', 'DISPOSITION_REQUIRED')
    `);
    for (const line of lines) named.push(toGrain(line));
  }

  const holds = await tx.execute<{
    product_variant_id: number;
    lot_id: number | null;
    serial_id: number | null;
  }>(sql`
    SELECT h.product_variant_id, h.lot_id, h.serial_id
      FROM inv_quality_holds h
     WHERE h.org_id = ${orgId}
       AND h.status = 'ACTIVE'
       AND (h.location_id = ${fromLocationId} OR h.location_id IS NULL)
  `);
  const held = holds.map(toGrain);

  return (grain: GrainKeyed): boolean => {
    if (held.some((hold) => covers(hold, grain))) return true;
    if (!inspectionFailed) return false;
    return !inspectionHasLines || named.some((line) => covers(line, grain));
  };
}
