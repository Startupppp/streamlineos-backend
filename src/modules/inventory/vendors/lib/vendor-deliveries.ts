import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { VendorDeliveriesInput } from "../dto/inv-vendors.schemas";

export interface VendorDelivery {
  poId: number;
  poNumber: string;
  status: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  firstReceiptDate: string | null;
  daysToReceive: number | null;
  /** Null when the order carried no promise date or has not been received. */
  onTime: boolean | null;
  orderedQty: string;
  receivedQty: string;
  lines: number;
  linesInFull: number;
  receiptCount: number;
  /** The GRNs behind the row, so a rate can be walked back to its documents. */
  receiptIds: number[];
  total: string;
  currency: string;
}

/**
 * C4 — the rows every rate on a vendor's scorecard was computed from.
 *
 * A rate nobody can walk back to its documents is a number to argue with
 * rather than act on, so each row carries the purchase order, the receipts
 * behind it and whether that one delivery was late. Two round trips at any
 * page size: the per-PO receipt and line rollups are laterals, not a query
 * per row.
 *
 * Separate from the scorecard itself because it answers a different question.
 * The scorecard is a fixed set of aggregates over a vendor's whole history and
 * returns the same shape whatever is behind it; this is a page of evidence,
 * and its failure mode is pagination — a caller asking for page 900 of a
 * supplier with nine deliveries gets an empty page, not a wrong rate.
 */
export async function listVendorDeliveries(
  db: Db,
  orgId: string,
  vendorId: number,
  filters: VendorDeliveriesInput,
) {
  const { page, limit } = filters;
  const offset = (page - 1) * limit;

  const [rows, countRows] = await Promise.all([
    db.execute<{
      po_id: number;
      po_number: string;
      status: string;
      order_date: string;
      expected_delivery_date: string | null;
      first_receipt_date: string | null;
      days_to_receive: string | null;
      on_time: boolean | null;
      ordered_qty: string;
      received_qty: string;
      lines: number;
      lines_in_full: number;
      receipt_count: number;
      receipt_ids: unknown;
      total: string;
      currency: string;
    }>(sql`
        SELECT po.id AS po_id,
               po.po_number,
               po.status::text AS status,
               po.order_date::text AS order_date,
               po.expected_delivery_date::text AS expected_delivery_date,
               r.first_receipt::text AS first_receipt_date,
               CASE WHEN r.first_receipt IS NULL THEN NULL
                    ELSE EXTRACT(
                      EPOCH FROM (r.first_receipt::timestamp - po.order_date::timestamp)
                    ) / 86400 END AS days_to_receive,
               CASE WHEN r.first_receipt IS NULL OR po.expected_delivery_date IS NULL THEN NULL
                    ELSE r.first_receipt <= po.expected_delivery_date END AS on_time,
               COALESCE(q.qty_ordered, '0') AS ordered_qty,
               COALESCE(q.qty_received, '0') AS received_qty,
               COALESCE(q.lines, 0) AS lines,
               COALESCE(q.lines_in_full, 0) AS lines_in_full,
               COALESCE(r.receipt_count, 0) AS receipt_count,
               COALESCE(r.receipt_ids, '[]'::json) AS receipt_ids,
               po.total::text AS total,
               po.currency
        FROM inv_purchase_orders po
        LEFT JOIN LATERAL (
          SELECT MIN(g.received_date) AS first_receipt,
                 COUNT(*)::int AS receipt_count,
                 json_agg(g.id ORDER BY g.received_date, g.id) AS receipt_ids
          FROM inv_grns g
          WHERE g.org_id = po.org_id AND g.po_id = po.id AND g.status <> 'CANCELLED'
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS lines,
                 COUNT(*) FILTER (WHERE pl.quantity_received >= pl.quantity)::int AS lines_in_full,
                 COALESCE(SUM(pl.quantity), 0)::text AS qty_ordered,
                 COALESCE(SUM(LEAST(pl.quantity_received, pl.quantity)), 0)::text AS qty_received
          FROM inv_po_lines pl
          WHERE pl.org_id = po.org_id AND pl.po_id = po.id
        ) q ON true
        WHERE po.org_id = ${orgId} AND po.vendor_id = ${vendorId}
        ORDER BY po.order_date DESC, po.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
    db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total
        FROM inv_purchase_orders po
        WHERE po.org_id = ${orgId} AND po.vendor_id = ${vendorId}
      `),
  ]);

  const total = countRows[0]?.total ?? 0;
  const items: VendorDelivery[] = rows.map((row) => ({
    poId: Number(row.po_id),
    poNumber: row.po_number,
    status: row.status,
    orderDate: row.order_date,
    expectedDeliveryDate: row.expected_delivery_date,
    firstReceiptDate: row.first_receipt_date,
    daysToReceive: row.days_to_receive === null ? null : Number(row.days_to_receive),
    onTime: row.on_time,
    orderedQty: row.ordered_qty,
    receivedQty: row.received_qty,
    lines: Number(row.lines),
    linesInFull: Number(row.lines_in_full),
    receiptCount: Number(row.receipt_count),
    receiptIds: Array.isArray(row.receipt_ids)
      ? row.receipt_ids.map((id: unknown) => Number(id))
      : [],
    total: row.total,
    currency: row.currency,
  }));

  return { items, total, page, totalPages: Math.ceil(total / limit) };
}
