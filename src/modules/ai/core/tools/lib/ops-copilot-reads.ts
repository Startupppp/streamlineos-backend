import { sql } from "drizzle-orm";
import { type Db } from "../../../../../db/drizzle.module";
import { availableQtySumSql } from "../../../../inventory/stock-engine/available-sql";
import type { ResolvedWarehouseScope } from "../../../../inventory/stock-engine/warehouse-scope.service";

export interface CopilotStockRow {
  variantId: number;
  onHand: number;
  committed: number;
  available: number;
}

export async function readCopilotVariantStock(
  db: Db,
  orgId: string,
  scope: ResolvedWarehouseScope,
  variantIds: readonly number[],
): Promise<CopilotStockRow[]> {
  if (variantIds.length === 0 || scope.isEmpty) return [];

  const rows = await db.execute<{
    variant_id: number;
    on_hand: string;
    committed: string;
    available: string;
  }>(sql`
    SELECT
      product_variant_id AS variant_id,
      COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
      COALESCE(SUM(committed::numeric), 0)::text AS committed,
      ${availableQtySumSql("inv_stock_levels")}::text AS available
    FROM inv_stock_levels
    WHERE org_id = ${orgId}
      AND product_variant_id = ANY(${sql`ARRAY[${sql.join(
        variantIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::int[]`})
      AND ${scope.location("inv_stock_levels.location_id")}
    GROUP BY product_variant_id
  `);

  return rows.map((row) => ({
    variantId: Number(row.variant_id),
    onHand: Number(row.on_hand),
    committed: Number(row.committed),
    available: Number(row.available),
  }));
}
