import { sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { classifyVelocity } from "../slotting-rules";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Moved with `recomputeVelocity`, its only reader. */
const VELOCITY_WINDOW_DAYS = 90;

/**
 * The two computations the nightly re-slot sweep runs, lifted out of
 * `slotting.service.ts` unchanged.
 *
 * Both already took their executor as an argument and touched nothing on the
 * service, and neither has ever had a caller outside it — `runReslotSweep` is
 * the only one, and it calls exactly these two. The rest of the service is CRUD
 * and authorization around slotting rules and recommendations; this is the
 * engine, and the seam between them was already there.
 */
  /* ---------------------------------------------------------------- *
   * Velocity
   * ---------------------------------------------------------------- */

  /**
   * Recompute ABC for one warehouse from the ledger.
   *
   * Counts *lines*, not units: slotting is about walks, and a SKU picked a
   * hundred times in ones costs a hundred journeys where one picked once in
   * hundreds costs one.
   */
export async function recomputeVelocity(
    executor: Tx | Db,
    orgId: string,
    warehouseId: number,
    windowDays = VELOCITY_WINDOW_DAYS,
  ): Promise<number> {
    const rows = await executor.execute<{
      product_variant_id: number; pick_count: number; issued_qty: string;
    }>(sql`
      SELECT t.product_variant_id,
             COUNT(*)::int AS pick_count,
             COALESCE(SUM(ABS(t.quantity_change)), 0)::text AS issued_qty
      FROM inv_stock_transactions t
      JOIN inv_locations l ON l.org_id = t.org_id AND l.id = t.location_id
      WHERE t.org_id = ${orgId}
        AND l.warehouse_id = ${warehouseId}
        AND t.quantity_change < 0
        AND t.quantity_bucket = 'ON_HAND'
        AND t.created_at >= now() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY t.product_variant_id
    `);

    const classified = classifyVelocity(
      rows.map((r) => ({
        productVariantId: Number(r.product_variant_id),
        pickCount: Number(r.pick_count),
        issuedQty: String(r.issued_qty),
      })),
    );

    for (const row of classified) {
      await executor.execute(sql`
        INSERT INTO inv_velocity_classes
          (org_id, warehouse_id, product_variant_id, velocity_class, pick_count, issued_qty, window_days, computed_at)
        VALUES (${orgId}, ${warehouseId}, ${row.productVariantId}, ${row.velocityClass},
                ${row.pickCount}, ${row.issuedQty}::numeric, ${windowDays}, now())
        ON CONFLICT (org_id, warehouse_id, product_variant_id)
        DO UPDATE SET velocity_class = EXCLUDED.velocity_class,
                      pick_count = EXCLUDED.pick_count,
                      issued_qty = EXCLUDED.issued_qty,
                      window_days = EXCLUDED.window_days,
                      computed_at = now()
      `);
    }

    return classified.length;
  }

  /* ---------------------------------------------------------------- *
   * Re-slot recommendations
   * ---------------------------------------------------------------- */

  /**
   * Compare where stock stands against where the rules put it, and record the
   * difference. **Writes no stock and creates no task.**
   *
   * `ON CONFLICT DO NOTHING` against the open-recommendation index is what stops
   * a nightly job burying the ones nobody has looked at yet under identical
   * copies of themselves.
   */
export async function generateRecommendations(
    executor: Tx | Db,
    orgId: string,
    warehouseId: number,
  ): Promise<number> {
    const misplaced = await executor.execute<{
      product_variant_id: number; from_location_id: number; quantity: string;
      rule_id: number; rule_name: string; zone_id: number;
    }>(sql`
      SELECT sl.product_variant_id,
             sl.location_id AS from_location_id,
             SUM(sl.on_hand)::text AS quantity,
             r.id AS rule_id,
             r.name AS rule_name,
             r.target_zone_location_id AS zone_id
      FROM inv_stock_levels sl
      JOIN inv_locations l ON l.org_id = sl.org_id AND l.id = sl.location_id
      JOIN inv_product_variants pv ON pv.org_id = sl.org_id AND pv.id = sl.product_variant_id
      JOIN inv_products p ON p.org_id = pv.org_id AND p.id = pv.product_id
      LEFT JOIN inv_velocity_classes v
        ON v.org_id = sl.org_id AND v.warehouse_id = l.warehouse_id
       AND v.product_variant_id = sl.product_variant_id
      JOIN LATERAL (
        SELECT r2.id, r2.name, r2.target_zone_location_id
        FROM inv_slotting_rules r2
        WHERE r2.org_id = sl.org_id
          AND r2.warehouse_id = l.warehouse_id
          AND r2.is_active = true
          AND (
            (r2.match_type = 'PRODUCT_VARIANT' AND r2.product_variant_id = sl.product_variant_id)
            OR (r2.match_type = 'CATEGORY' AND r2.category_id = p.category_id)
            OR (r2.match_type = 'VELOCITY_CLASS' AND r2.velocity_class = v.velocity_class)
          )
        ORDER BY r2.priority ASC, r2.id ASC
        LIMIT 1
      ) r ON TRUE
      WHERE sl.org_id = ${orgId}
        AND l.warehouse_id = ${warehouseId}
        AND sl.on_hand > 0
        AND l.is_sellable IS NOT FALSE
        -- Already in the right zone: nothing to recommend. The walk is the
        -- recursive descent from the rule's zone down to the bins under it.
        AND NOT EXISTS (
          WITH RECURSIVE zone AS (
            SELECT id, 1 AS depth FROM inv_locations
             WHERE org_id = sl.org_id AND id = r.target_zone_location_id
            UNION ALL
            SELECT c.id, zone.depth + 1 FROM inv_locations c
              JOIN zone ON c.parent_location_id = zone.id
             WHERE c.org_id = sl.org_id AND zone.depth < 16
          )
          SELECT 1 FROM zone WHERE zone.id = sl.location_id
        )
      GROUP BY sl.product_variant_id, sl.location_id, r.id, r.name, r.target_zone_location_id
    `);

    let written = 0;
    for (const row of misplaced) {
      const result = await executor.execute(sql`
        INSERT INTO inv_slotting_recommendations
          (org_id, warehouse_id, product_variant_id, from_location_id, to_zone_location_id,
           quantity, rule_id, reason, status)
        VALUES (${orgId}, ${warehouseId}, ${row.product_variant_id}, ${row.from_location_id},
                ${row.zone_id}, ${row.quantity}::numeric, ${row.rule_id},
                ${`Rule "${row.rule_name}" puts this SKU in another zone`}, 'PENDING')
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      written += result.length;
    }

    return written;
  }
