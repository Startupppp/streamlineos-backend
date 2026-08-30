import { sql, type SQL } from "drizzle-orm";

/**
 * D5 — inventory value, computed in Postgres `numeric` and projected `::text`.
 *
 * Every figure on this report used to be assembled in JavaScript from
 * `parseFloat`: `onHand * parseFloat(avgCost)`, then `Math.round(v * 10000) /
 * 10000` to hide the binary fraction it had just created. Two consequences, both
 * observed. A page total was the sum of fifty rounded floats and disagreed with
 * the same query grouped differently; and the weighted-average branch multiplied
 * total on-hand by `AVG(average_cost)` — the unweighted mean of each location's
 * own average — which is not a weighted average of anything and drifts further
 * the more unevenly stock is spread. Both are fixed by doing the arithmetic once,
 * where the data is, in a type that has no binary fraction.
 *
 * The value per row, per costing method:
 *
 *   FIFO              Σ over open layers of remaining_value
 *   STANDARD          on_hand × products.standard_cost
 *   WEIGHTED_AVERAGE  Σ per stock row of on_hand × average_cost
 *
 * The weighted-average branch sums the product per row rather than multiplying
 * the total by an average of averages, so a variant held at two locations at
 * different costs is valued at what it actually cost.
 */
export interface ValuationQueryParams {
  orgId: string;
  /** Predicate over a location column, from `WarehouseScopeService`. */
  locationScope: (column: string) => SQL;
  warehouseId?: number;
  categoryId?: number;
  /** The date the figure is quoted at. */
  asOfDate: string;
  limit: number;
  offset: number;
}

/** Narrows a location column to one warehouse, on top of the caller's scope. */
function warehouseFilter(orgId: string, column: string, warehouseId?: number): SQL {
  if (warehouseId == null) return sql`TRUE`;
  return sql`${sql.raw(column)} IN (
    SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId}
  )`;
}

function categoryFilter(categoryId?: number): SQL {
  if (categoryId == null) return sql`TRUE`;
  return sql`p.category_id = ${categoryId}`;
}

/**
 * The projection every grain shares. `count(*) OVER ()` and `SUM(...) OVER ()`
 * carry the row count and the grand total of the *whole* filtered set out of the
 * same pass, so the page total is not the sum of one page — which is what the
 * previous implementation reported and what made two pages of the same report
 * add up to less than the report.
 */
const ROW_PROJECTION = sql`
  r.product_variant_id                                   AS "productVariantId",
  r.variant_sku                                          AS "variantSku",
  r.variant_name                                         AS "variantName",
  r.product_id                                           AS "productId",
  r.product_name                                         AS "productName",
  r.costing_method                                       AS "costingMethod",
  r.on_hand::text                                        AS "onHand",
  r.value::text                                          AS "value",
  r.fifo_value::text                                     AS "fifoValue",
  COALESCE(r.standard_cost, 0)::text                     AS "standardCost",
  (CASE WHEN r.on_hand <> 0 THEN r.value / r.on_hand ELSE 0 END)::text AS "unitCostBasis",
  r.layer_count::int                                     AS "layerCount",
  count(*) OVER ()::int                                  AS "totalRows",
  SUM(r.value) OVER ()::text                             AS "totalValue",
  SUM(r.on_hand) OVER ()::text                           AS "totalOnHand"
`;

/**
 * Value as it stands now, from the stock projection.
 *
 * `inv_stock_levels` is the engine's own projection and is the authority on what
 * is on hand today, so today's valuation reads it rather than re-deriving it from
 * the ledger — a report that disagreed with the stock screen would be reporting
 * its own arithmetic, not the warehouse.
 *
 * NEO-11: owned stock only. Consigned goods are on hand and are not ours, and
 * valuing them would put a supplier's inventory on our balance sheet.
 */
export function liveValuationSql(params: ValuationQueryParams): SQL {
  const { orgId, locationScope, warehouseId, categoryId, limit, offset } = params;
  return sql`
    WITH levels AS (
      SELECT sl.product_variant_id,
             SUM(sl.on_hand::numeric)                                            AS on_hand,
             SUM(sl.on_hand::numeric * COALESCE(sl.average_cost, 0)::numeric)    AS average_value
      FROM inv_stock_levels sl
      WHERE sl.org_id = ${orgId}
        AND ${locationScope("sl.location_id")}
        AND ${warehouseFilter(orgId, "sl.location_id", warehouseId)}
        -- NEO-11. Consigned stock is standing in our building and belongs to
        -- somebody else until it is sold. Valuing it would put a supplier's
        -- goods on our balance sheet, which is the one thing a consignment
        -- arrangement exists to avoid.
        AND sl.ownership = 'OWNED'
      GROUP BY sl.product_variant_id
    ),
    layers AS (
      SELECT vl.product_variant_id,
             SUM(vl.remaining_value::numeric) AS value,
             count(*)                         AS layer_count
      FROM inv_valuation_layers vl
      WHERE vl.org_id = ${orgId}
        AND vl.remaining_quantity::numeric > 0
        AND ${locationScope("vl.location_id")}
        AND ${warehouseFilter(orgId, "vl.location_id", warehouseId)}
      GROUP BY vl.product_variant_id
    ),
    r AS (
      SELECT l.product_variant_id,
             v.sku          AS variant_sku,
             v.name         AS variant_name,
             p.id           AS product_id,
             p.name         AS product_name,
             p.costing_method,
             p.standard_cost::numeric      AS standard_cost,
             l.on_hand,
             COALESCE(y.value, 0)          AS fifo_value,
             COALESCE(y.layer_count, 0)    AS layer_count,
             CASE p.costing_method
               WHEN 'FIFO'     THEN COALESCE(y.value, 0)
               WHEN 'STANDARD' THEN l.on_hand * COALESCE(p.standard_cost, 0)::numeric
               ELSE l.average_value
             END                           AS value
      FROM levels l
      JOIN inv_product_variants v ON v.id = l.product_variant_id AND v.org_id = ${orgId}
      JOIN inv_products p         ON p.id = v.product_id
      LEFT JOIN layers y          ON y.product_variant_id = l.product_variant_id
      WHERE ${categoryFilter(categoryId)}
    )
    SELECT ${ROW_PROJECTION}
    FROM r
    ORDER BY r.variant_sku
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Value as it stood on a past date, rebuilt from the append-only ledgers.
 *
 * Nothing is stored per date, so both halves are replayed:
 *
 *   on hand   Σ of `quantity_change` over ON_HAND movements up to the date. The
 *             projection cannot answer this — it holds one number, today's.
 *   value     per layer, `quantity − Σ consumptions up to the date`, times the
 *             layer's unit cost. This is why `commitIssue` writes a consumption
 *             row per layer it draws from: without those rows a past valuation
 *             would be unreconstructible, and `remaining_quantity` alone only
 *             ever describes now.
 *
 * The weighted-average cost as at a date comes from `inv_average_cost_history`,
 * the same table the engine writes on every averaged receipt — the last average
 * recorded on or before the date, not today's.
 */
export function asAtValuationSql(params: ValuationQueryParams): SQL {
  const { orgId, locationScope, warehouseId, categoryId, asOfDate, limit, offset } = params;
  return sql`
    WITH moved AS (
      SELECT t.product_variant_id,
             SUM(t.quantity_change::numeric) AS on_hand
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.quantity_bucket = 'ON_HAND'
        AND ${locationScope("t.location_id")}
        AND ${warehouseFilter(orgId, "t.location_id", warehouseId)}
        AND COALESCE(t.posting_date, t.created_at::date) <= ${asOfDate}::date
      GROUP BY t.product_variant_id
    ),
    layers AS (
      SELECT vl.product_variant_id,
             SUM(GREATEST(vl.quantity::numeric - COALESCE(c.consumed, 0), 0) * vl.unit_cost::numeric) AS value,
             count(*) FILTER (WHERE vl.quantity::numeric - COALESCE(c.consumed, 0) > 0) AS layer_count
      FROM inv_valuation_layers vl
      LEFT JOIN LATERAL (
        SELECT SUM(vc.quantity::numeric) AS consumed
        FROM inv_valuation_consumptions vc
        WHERE vc.org_id = vl.org_id
          AND vc.valuation_layer_id = vl.id
          AND vc.created_at::date <= ${asOfDate}::date
      ) c ON TRUE
      WHERE vl.org_id = ${orgId}
        AND vl.created_at::date <= ${asOfDate}::date
        AND ${locationScope("vl.location_id")}
        AND ${warehouseFilter(orgId, "vl.location_id", warehouseId)}
      GROUP BY vl.product_variant_id
    ),
    averages AS (
      SELECT DISTINCT ON (h.product_variant_id)
             h.product_variant_id,
             h.average_after::numeric AS average_cost
      FROM inv_average_cost_history h
      WHERE h.org_id = ${orgId}
        AND h.created_at::date <= ${asOfDate}::date
      ORDER BY h.product_variant_id, h.created_at DESC, h.id DESC
    ),
    r AS (
      SELECT m.product_variant_id,
             v.sku          AS variant_sku,
             v.name         AS variant_name,
             p.id           AS product_id,
             p.name         AS product_name,
             p.costing_method,
             p.standard_cost::numeric   AS standard_cost,
             m.on_hand,
             COALESCE(y.value, 0)       AS fifo_value,
             COALESCE(y.layer_count, 0) AS layer_count,
             CASE p.costing_method
               WHEN 'FIFO'     THEN COALESCE(y.value, 0)
               WHEN 'STANDARD' THEN m.on_hand * COALESCE(p.standard_cost, 0)::numeric
               ELSE m.on_hand * COALESCE(a.average_cost, 0)
             END                        AS value
      FROM moved m
      JOIN inv_product_variants v ON v.id = m.product_variant_id AND v.org_id = ${orgId}
      JOIN inv_products p         ON p.id = v.product_id
      LEFT JOIN layers y          ON y.product_variant_id = m.product_variant_id
      LEFT JOIN averages a        ON a.product_variant_id = m.product_variant_id
      WHERE ${categoryFilter(categoryId)}
        AND (m.on_hand <> 0 OR COALESCE(y.value, 0) <> 0)
    )
    SELECT ${ROW_PROJECTION}
    FROM r
    ORDER BY r.variant_sku
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * The layers behind one variant's value, each carrying how much of it a past
 * date had left and how much had already been drawn out of it. This is the
 * evidence a valuation row drills into.
 */
export function layerEvidenceSql(
  orgId: string,
  variantId: number,
  locationScope: (column: string) => SQL,
  asOfDate: string,
  warehouseId: number | undefined,
  limit: number,
  offset: number,
): SQL {
  return sql`
    SELECT
      vl.id                                         AS "layerId",
      vl.created_at                                 AS "createdAt",
      vl.stock_transaction_id                       AS "stockTransactionId",
      vl.costing_method                             AS "costingMethod",
      vl.source_type                                AS "sourceType",
      vl.source_id                                  AS "sourceId",
      vl.location_id                                AS "locationId",
      loc.name                                      AS "locationName",
      wh.name                                       AS "warehouseName",
      vl.lot_id                                     AS "lotId",
      lot.lot_number                                AS "lotNumber",
      vl.quantity::text                             AS "quantity",
      vl.unit_cost::text                            AS "unitCost",
      vl.total_value::text                          AS "totalValue",
      vl.remaining_quantity::text                   AS "remainingQuantity",
      vl.remaining_value::text                      AS "remainingValue",
      COALESCE(c.consumed, 0)::text                 AS "consumedQuantity",
      COALESCE(c.consumption_count, 0)::int         AS "consumptionCount",
      GREATEST(vl.quantity::numeric - COALESCE(c.consumed, 0), 0)::text AS "remainingQuantityAsAt",
      (GREATEST(vl.quantity::numeric - COALESCE(c.consumed, 0), 0) * vl.unit_cost::numeric)::text AS "remainingValueAsAt",
      count(*) OVER ()::int                         AS "totalRows"
    FROM inv_valuation_layers vl
    LEFT JOIN inv_locations loc ON loc.id = vl.location_id
    LEFT JOIN inv_warehouses wh ON wh.id = loc.warehouse_id
    LEFT JOIN inv_lots lot      ON lot.id = vl.lot_id
    LEFT JOIN LATERAL (
      SELECT SUM(vc.quantity::numeric) AS consumed, count(*) AS consumption_count
      FROM inv_valuation_consumptions vc
      WHERE vc.org_id = vl.org_id
        AND vc.valuation_layer_id = vl.id
        AND vc.created_at::date <= ${asOfDate}::date
    ) c ON TRUE
    WHERE vl.org_id = ${orgId}
      AND vl.product_variant_id = ${variantId}
      AND vl.created_at::date <= ${asOfDate}::date
      AND ${locationScope("vl.location_id")}
      AND ${warehouseFilter(orgId, "vl.location_id", warehouseId)}
    ORDER BY vl.created_at DESC, vl.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Consumption lines: which layer an issue drew from, how much it took and what
 * that draw cost. One row per (movement, layer) pair, so a COGS figure is
 * traceable to the receipts that produced it rather than asserted.
 */
export function consumptionEvidenceSql(
  orgId: string,
  filters: SQL,
  locationScope: (column: string) => SQL,
  limit: number,
  offset: number,
): SQL {
  return sql`
    SELECT
      vc.id                        AS "consumptionId",
      vc.created_at                AS "createdAt",
      vc.stock_transaction_id      AS "stockTransactionId",
      vc.valuation_layer_id        AS "valuationLayerId",
      vc.quantity::text            AS "quantity",
      vc.unit_cost::text           AS "unitCost",
      vc.total_cost::text          AS "totalCost",
      vl.unit_cost::text           AS "layerUnitCost",
      vl.created_at                AS "layerCreatedAt",
      vl.source_type               AS "layerSourceType",
      vl.source_id                 AS "layerSourceId",
      vl.costing_method            AS "costingMethod",
      t.product_variant_id         AS "productVariantId",
      t.transaction_type           AS "transactionType",
      t.reference_type             AS "referenceType",
      t.reference_id               AS "referenceId",
      COALESCE(t.posting_date, t.created_at::date)::text AS "postingDate",
      v.sku                        AS "variantSku",
      p.name                       AS "productName",
      loc.name                     AS "locationName",
      count(*) OVER ()::int        AS "totalRows"
    FROM inv_valuation_consumptions vc
    JOIN inv_valuation_layers vl    ON vl.id = vc.valuation_layer_id AND vl.org_id = vc.org_id
    JOIN inv_stock_transactions t   ON t.id = vc.stock_transaction_id AND t.org_id = vc.org_id
    JOIN inv_product_variants v     ON v.id = t.product_variant_id
    JOIN inv_products p             ON p.id = v.product_id
    LEFT JOIN inv_locations loc     ON loc.id = t.location_id
    WHERE vc.org_id = ${orgId}
      AND ${locationScope("t.location_id")}
      AND ${filters}
    ORDER BY vc.created_at DESC, vc.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}
