import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { ListPickExceptionsInput } from "./dto/picking.schemas";
import { PICK_LINE_CLOSED_SQL } from "./pick-exception-policy";

/** One exception as the supervisor queue lists it. */
export interface PickExceptionSummary {
  pickLineId: number;
  pickListId: number;
  pickNumber: string;
  soNumber: string | null;
  soLineId: number | null;
  reason: string;
  status: string;
  resolution: string | null;
  notes: string | null;
  resolutionNotes: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  reportedBy: string | null;
  reportedByName: string | null;
  reportedAt: string | null;
  resolvedAt: string | null;
  sku: string;
  variantName: string;
  substituteSku: string | null;
  substituteQuantity: string | null;
  quantityToPick: string;
  quantityPicked: string;
  locationCode: string | null;
  foundLocationCode: string | null;
  warehouseId: number | null;
  warehouseName: string | null;
  /** Whether this row is what is keeping its wave open. */
  blocksWave: boolean;
}

interface QueueRow extends Record<string, unknown> {
  pick_line_id: number;
  pick_list_id: number;
  pick_number: string;
  so_number: string | null;
  so_line_id: number | null;
  reason: string;
  status: string;
  resolution: string | null;
  notes: string | null;
  resolution_notes: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  reported_by: string | null;
  reported_by_name: string | null;
  reported_at: string | null;
  resolved_at: string | null;
  sku: string;
  variant_name: string;
  substitute_sku: string | null;
  substitute_quantity: string | null;
  quantity_to_pick: string;
  quantity_picked: string;
  location_code: string | null;
  found_location_code: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  blocks_wave: boolean;
}

/**
 * B5, item 5 — the supervisor's queue.
 *
 * Warehouse-scoped like every other inventory list, through the wave the line
 * belongs to: a supervisor responsible for one building has no business being
 * asked to sign off another's write-offs.
 *
 * **Not cached.** A queue whose whole value is that it is current — an exception
 * somebody resolved a second ago must not still read as waiting — and a list this
 * volatile behind a cache is a queue that lies. Same reasoning as the wave board.
 *
 * `blocks_wave` is computed from `PICK_LINE_CLOSED_SQL` rather than from the
 * reason, so the queue and the wave can never disagree about which row is
 * holding a walk open. It is the difference between "here are some exceptions"
 * and "here is the one a picker is standing still for".
 *
 * The user names are read through explicit projections of `users`. That table
 * still holds authentication secrets and legacy payroll columns, so nothing here
 * reaches it through a relation.
 */
export async function queryPickExceptionQueue(
  db: Db,
  orgId: string,
  userId: string,
  filters: ListPickExceptionsInput,
  warehousePredicate: (column: SQL) => SQL,
): Promise<{
  items: PickExceptionSummary[];
  total: number;
  page: number;
  totalPages: number;
  openCount: number;
}> {
  const statusPredicate = filters.status
    ? sql`AND pll.exception_status = ${filters.status}`
    : sql``;
  const reasonPredicate = filters.reason
    ? sql`AND pll.exception_reason = ${filters.reason}`
    : sql``;
  const warehouseFilter = filters.warehouseId
    ? sql`AND pl.warehouse_id = ${filters.warehouseId}`
    : sql``;
  const ownershipPredicate =
    filters.ownership === "MINE" ? sql`AND pll.exception_owner_id = ${userId}` : sql``;

  const where = sql`
    pll.org_id = ${orgId}
      AND pll.exception_reason IS NOT NULL
      AND ${warehousePredicate(sql`pl.warehouse_id`)}
      ${statusPredicate}
      ${reasonPredicate}
      ${warehouseFilter}
      ${ownershipPredicate}
  `;

  const offset = (filters.page - 1) * filters.limit;

  const [rows, counted, open] = await Promise.all([
    db.execute<QueueRow>(sql`
      SELECT pll.id AS pick_line_id,
             pll.pick_list_id,
             pl.pick_number,
             so.so_number,
             pll.so_line_id,
             pll.exception_reason AS reason,
             pll.exception_status AS status,
             pll.exception_resolution AS resolution,
             pll.exception_notes AS notes,
             pll.exception_resolution_notes AS resolution_notes,
             pll.exception_owner_id AS owner_user_id,
             owner.name AS owner_name,
             pll.exception_reported_by AS reported_by,
             reporter.name AS reported_by_name,
             pll.exception_reported_at AS reported_at,
             pll.exception_resolved_at AS resolved_at,
             v.sku,
             v.name AS variant_name,
             sub.sku AS substitute_sku,
             pll.substitute_quantity,
             pll.quantity_to_pick,
             pll.quantity_picked,
             loc.code AS location_code,
             found.code AS found_location_code,
             pl.warehouse_id,
             w.name AS warehouse_name,
             (NOT ${PICK_LINE_CLOSED_SQL}) AS blocks_wave
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
        JOIN inv_product_variants v
          ON v.org_id = pll.org_id AND v.id = pll.product_variant_id
        LEFT JOIN inv_product_variants sub
          ON sub.org_id = pll.org_id AND sub.id = pll.substitute_variant_id
        LEFT JOIN inv_locations loc
          ON loc.org_id = pll.org_id AND loc.id = pll.location_id
        LEFT JOIN inv_locations found
          ON found.org_id = pll.org_id AND found.id = pll.exception_location_id
        LEFT JOIN inv_warehouses w
          ON w.org_id = pl.org_id AND w.id = pl.warehouse_id
        LEFT JOIN inv_so_lines sol
          ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
        LEFT JOIN inv_sales_orders so
          ON so.org_id = sol.org_id AND so.id = sol.so_id
        LEFT JOIN users owner ON owner.id = pll.exception_owner_id
        LEFT JOIN users reporter ON reporter.id = pll.exception_reported_by
       WHERE ${where}
       ORDER BY (pll.exception_status = 'OPEN') DESC, pll.exception_reported_at DESC NULLS LAST, pll.id DESC
       LIMIT ${filters.limit} OFFSET ${offset}
    `),
    db.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
       WHERE ${where}
    `),
    // The badge count, and it deliberately ignores the caller's status filter:
    // a supervisor who has filtered down to RESOLVED still needs to see that
    // eleven are waiting.
    db.execute<{ open: number }>(sql`
      SELECT COUNT(*)::int AS open
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
       WHERE pll.org_id = ${orgId}
         AND pll.exception_reason IS NOT NULL
         AND pll.exception_status = 'OPEN'
         AND ${warehousePredicate(sql`pl.warehouse_id`)}
    `),
  ]);

  const total = Number(counted[0]?.total ?? 0);

  return {
    items: rows.map((row) => ({
      pickLineId: Number(row.pick_line_id),
      pickListId: Number(row.pick_list_id),
      pickNumber: row.pick_number,
      soNumber: row.so_number,
      soLineId: row.so_line_id === null ? null : Number(row.so_line_id),
      reason: row.reason,
      status: row.status,
      resolution: row.resolution,
      notes: row.notes,
      resolutionNotes: row.resolution_notes,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name,
      reportedBy: row.reported_by,
      reportedByName: row.reported_by_name,
      reportedAt: row.reported_at === null ? null : String(row.reported_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
      sku: row.sku,
      variantName: row.variant_name,
      substituteSku: row.substitute_sku,
      substituteQuantity: row.substitute_quantity,
      quantityToPick: row.quantity_to_pick,
      quantityPicked: row.quantity_picked,
      locationCode: row.location_code,
      foundLocationCode: row.found_location_code,
      warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
      warehouseName: row.warehouse_name,
      blocksWave: row.blocks_wave === true,
    })),
    total,
    page: filters.page,
    totalPages: Math.ceil(total / filters.limit),
    openCount: Number(open[0]?.open ?? 0),
  };
}
