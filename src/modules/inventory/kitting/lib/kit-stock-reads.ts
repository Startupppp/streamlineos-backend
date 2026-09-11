import { and, eq, inArray, sql } from "drizzle-orm";
import { invStockTransactions } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { addDec, cmpDec } from "../../stock-engine/decimal";
import { availableQtySumSql } from "../../stock-engine/available-sql";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The three reads a kit build makes against stock, as plain queries.
 *
 * They are here because they are the only part of kitting that touches
 * `inv_stock_levels` and `inv_stock_transactions` at all, and because both build
 * commands and the availability answer need them: `availableByComponent` serves
 * `buildable` (warehouse- or scope-wide) and `assemble` (at one location) from
 * one query, and the two cost readbacks are what makes a kit cost what its
 * components actually consumed rather than an estimate of it.
 *
 * They take the executor they are to run on — `Db` or a transaction handle —
 * rather than a deps bag, because that argument is the whole of their
 * dependency and passing it explicitly is what stops a costing readback from
 * silently running outside the transaction whose rows it is reading.
 */
export async function availableByComponent(
  executor: Tx | Db,
  orgId: string,
  bom: readonly { componentVariantId: number }[],
  warehouseId: number | null,
  locationId?: number | null,
  /** `null` is unrestricted; a list narrows the sum to those warehouses. */
  scope?: number[] | null,
): Promise<Map<number, string>> {
  const ids = bom.map((line) => line.componentVariantId);
  if (ids.length === 0) return new Map();

  const rows = await executor.execute<{ product_variant_id: number; available: string }>(sql`
    SELECT sl.product_variant_id, ${availableQtySumSql("sl")} AS available
    FROM inv_stock_levels sl
    JOIN inv_locations loc ON loc.id = sl.location_id AND loc.org_id = sl.org_id
    WHERE sl.org_id = ${orgId}
      AND sl.product_variant_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ${locationId != null ? sql`AND sl.location_id = ${locationId}` : sql``}
      ${warehouseId != null ? sql`AND loc.warehouse_id = ${warehouseId}` : sql``}
      ${
        scope != null && scope.length > 0
          ? sql`AND loc.warehouse_id IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`
          : sql``
      }
    GROUP BY sl.product_variant_id
  `);

  return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.available)]));
}

/** What a set of movements actually cost, read back off the ledger rows. */
export async function costOf(tx: Tx, orgId: string, transactionIds: readonly number[]): Promise<string> {
  if (transactionIds.length === 0) return "0.0000";
  const rows = await tx
    .select({ totalCost: invStockTransactions.totalCost })
    .from(invStockTransactions)
    .where(
      and(
        eq(invStockTransactions.orgId, orgId),
        inArray(invStockTransactions.id, [...transactionIds]),
      ),
    );

  return rows.reduce((sum, row) => {
    const value = row.totalCost ?? "0";
    // An issue's total cost is negative on the row; the build's cost is what
    // left, so the sign is dropped here rather than by every caller.
    return addDec(sum, cmpDec(value, "0") < 0 ? value.replace("-", "") : value);
  }, "0");
}

export async function unitCostByVariant(
  tx: Tx,
  orgId: string,
  variantIds: readonly number[],
  locationId: number,
): Promise<Map<number, string>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx.execute<{ product_variant_id: number; average_cost: string | null }>(sql`
    SELECT product_variant_id, average_cost
    FROM inv_stock_levels
    WHERE org_id = ${orgId}
      AND location_id = ${locationId}
      AND product_variant_id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
  `);
  return new Map(
    rows.map((r) => [Number(r.product_variant_id), String(r.average_cost ?? "0")]),
  );
}
