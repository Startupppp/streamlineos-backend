import { sql } from "drizzle-orm";
import type { Db } from "../../../../../db/drizzle.module";
import { availableQtySumSql } from "../../../stock-engine/available-sql";
import { type ResolvedProposalRow } from "../po-batch-lines";

/** Anything that can run a raw statement. Moved here with `resolve`, its main reader. */
export type QueryExecutor = Pick<Db, "execute">;

/**
 * Resolving a reorder proposal into the lines a draft PO would carry, lifted out of `po-batch.service.ts` unchanged. 135 lines, private, using only the db handle, with no caller outside that service — the batching, preview and create paths stay behind.
 */
  /**
   * Everything a proposal needs to become an order line, in one query.
   *
   * The lateral joins are deliberate: a per-proposal round trip for the
   * position, the last paid price and the open-draft check is three queries per
   * SKU, and a batch is dozens of SKUs. `availableQtySumSql` is the one
   * availability formula (`available-sql.ts`) — writing the subtraction out here
   * is how the six copies A1 removed came about.
   */
export async function resolve(
    db: Db,

    orgId: string,
    proposalIds: readonly number[],
    executor: QueryExecutor = db,
  ): Promise<ResolvedProposalRow[]> {
    if (proposalIds.length === 0) return [];
    const rows = await executor.execute<{
      proposal_id: number;
      product_variant_id: number;
      warehouse_id: number | null;
      warehouse_name: string | null;
      reorder_point: string | null;
      applicable: boolean;
      refusal_reason: string | null;
      generated_at: Date;
      variant_sku: string;
      product_name: string;
      min_order_qty: string | null;
      order_multiple: string | null;
      vendor_id: number | null;
      vendor_name: string | null;
      currency: string | null;
      available: string;
      on_order: string;
      last_unit_cost: string | null;
      duplicate_po_id: number | null;
      duplicate_po_number: string | null;
    }>(sql`
      SELECT f.id AS proposal_id,
             f.product_variant_id,
             f.warehouse_id,
             w.name AS warehouse_name,
             f.reorder_point,
             f.applicable,
             f.refusal_reason,
             f.generated_at,
             pv.sku AS variant_sku,
             p.name AS product_name,
             p.min_order_qty,
             p.order_multiple,
             v.id AS vendor_id,
             v.name AS vendor_name,
             v.currency,
             COALESCE(pos.available, '0')::text AS available,
             COALESCE(pos.on_order, '0')::text AS on_order,
             last_cost.unit_cost AS last_unit_cost,
             draft.po_id AS duplicate_po_id,
             draft.po_number AS duplicate_po_number
      FROM inv_demand_forecasts f
      JOIN inv_product_variants pv
        ON pv.org_id = f.org_id AND pv.id = f.product_variant_id
      JOIN inv_products p
        ON p.org_id = pv.org_id AND p.id = pv.product_id
      LEFT JOIN inv_warehouses w
        ON w.org_id = f.org_id AND w.id = f.warehouse_id
      LEFT JOIN inv_reorder_rules rr
        ON rr.org_id = f.org_id
       AND rr.product_variant_id = f.product_variant_id
       AND rr.warehouse_id IS NOT DISTINCT FROM f.warehouse_id
       AND rr.is_active = true
      LEFT JOIN inv_vendors v
        ON v.org_id = f.org_id AND v.id = COALESCE(rr.vendor_id, p.default_vendor_id)
      LEFT JOIN LATERAL (
        SELECT ${availableQtySumSql("sl")}::text AS available,
               COALESCE(SUM(sl.on_order), 0)::text AS on_order
        FROM inv_stock_levels sl
        WHERE sl.org_id = f.org_id
          AND sl.product_variant_id = f.product_variant_id
          AND (
            f.warehouse_id IS NULL
            OR EXISTS (
              SELECT 1 FROM inv_locations pos_loc
              WHERE pos_loc.id = sl.location_id
                AND pos_loc.org_id = sl.org_id
                AND pos_loc.warehouse_id = f.warehouse_id
            )
          )
      ) pos ON TRUE
      LEFT JOIN LATERAL (
        SELECT pl.unit_cost
        FROM inv_po_lines pl
        JOIN inv_purchase_orders po ON po.org_id = pl.org_id AND po.id = pl.po_id
        WHERE pl.org_id = f.org_id
          AND pl.product_variant_id = f.product_variant_id
          AND po.vendor_id = COALESCE(rr.vendor_id, p.default_vendor_id)
        ORDER BY po.order_date DESC, po.id DESC
        LIMIT 1
      ) last_cost ON TRUE
      LEFT JOIN LATERAL (
        SELECT po.id AS po_id, po.po_number
        FROM inv_purchase_orders po
        JOIN inv_po_lines pl ON pl.org_id = po.org_id AND pl.po_id = po.id
        WHERE po.org_id = f.org_id
          AND po.status = 'DRAFT'
          AND pl.product_variant_id = f.product_variant_id
          AND po.vendor_id = COALESCE(rr.vendor_id, p.default_vendor_id)
          AND po.warehouse_id IS NOT DISTINCT FROM f.warehouse_id
        ORDER BY po.id DESC
        LIMIT 1
      ) draft ON TRUE
      WHERE f.org_id = ${orgId}
        AND f.id IN (${sql.join(proposalIds.map((id) => sql`${id}`), sql`, `)})
    `);

    return rows.map((row) => ({
      proposalId: Number(row.proposal_id),
      productVariantId: Number(row.product_variant_id),
      warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
      warehouseName: row.warehouse_name,
      reorderPoint: row.reorder_point,
      applicable: row.applicable,
      refusalReason: row.refusal_reason,
      generatedAt: new Date(row.generated_at).toISOString(),
      variantSku: row.variant_sku,
      productName: row.product_name,
      minOrderQty: row.min_order_qty,
      orderMultiple: row.order_multiple,
      vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
      vendorName: row.vendor_name,
      currency: row.currency,
      available: row.available,
      onOrder: row.on_order,
      lastUnitCost: row.last_unit_cost,
      duplicatePoNumber: row.duplicate_po_number,
    }));
  }
