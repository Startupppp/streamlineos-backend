import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { ListWavesInput } from "./dto/picking.schemas";
import { PICK_LINE_CLOSED_SQL } from "./pick-exception-policy";

/** A wave header as the workbench lists it. */
export interface WaveSummary {
  id: number;
  pickNumber: string;
  status: string;
  warehouseId: number | null;
  warehouseName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  claimedAt: string | null;
  createdAt: string;
  orderCount: number;
  lineCount: number;
  linesClosed: number;
  /** B5. How many of this wave's lines are waiting on a reviewer. */
  openExceptions: number;
}

interface WaveQueueRow extends Record<string, unknown> {
  id: number;
  pick_number: string;
  status: string;
  warehouse_id: number | null;
  warehouse_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  claimed_at: string | null;
  created_at: string;
  order_count: number;
  line_count: number;
  lines_closed: number;
  open_exceptions: number;
}

/**
 * B4, item 5 — the workbench's queue.
 *
 * Warehouse-scoped like every other inventory list: a wave is attributed to its
 * warehouse, and a picker assigned to one building has no business seeing
 * another's walks. A wave with no warehouse is attributable to none of the
 * caller's, so an unrestricted caller is the only one who sees it — which is
 * what `warehousePredicate` already means.
 *
 * **`assignment` is a view, never a user id.** A body or query that could name
 * the picker could name somebody else's queue; "whose waves am I looking at" is
 * answered from the token.
 *
 * **Not cached.** The queue's whole value is that it is current — a wave someone
 * else claimed a second ago must not still read as available — and a list this
 * volatile behind a cache is a workbench that lies.
 *
 * `so_id IS NULL` is the wave filter. A single-order pick list is a receipt of
 * what one order's picker did; this board is the walks.
 *
 * The per-wave counts come from one LATERAL aggregate rather than a second round
 * trip per row: at 25 rows a page that is 25 queries a keystroke.
 */
export async function queryWaveQueue(
  db: Db,
  orgId: string,
  userId: string,
  filters: ListWavesInput,
  warehousePredicate: (column: SQL) => SQL,
): Promise<{ items: WaveSummary[]; total: number; page: number; totalPages: number }> {
  const statusPredicate = filters.status ? sql`AND pl.status = ${filters.status}` : sql``;
  const warehouseFilter = filters.warehouseId
    ? sql`AND pl.warehouse_id = ${filters.warehouseId}`
    : sql``;
  const assignmentPredicate =
    filters.assignment === "MINE"
      ? sql`AND pl.assigned_to = ${userId}`
      : filters.assignment === "UNCLAIMED"
        ? sql`AND pl.assigned_to IS NULL`
        : sql``;
  // Half-open at the top so the whole of `to` is included, which is the same
  // convention the throughput report measures its window by. A board and the
  // report it was reached from disagreeing about what "to the 8th" covers is
  // exactly the drill-through this filter exists to make possible.
  const fromPredicate = filters.from ? sql`AND pl.created_at >= ${filters.from}::date` : sql``;
  const toPredicate = filters.to ? sql`AND pl.created_at < (${filters.to}::date + 1)` : sql``;

  const where = sql`
    pl.org_id = ${orgId}
      AND pl.so_id IS NULL
      AND ${warehousePredicate(sql`pl.warehouse_id`)}
      ${statusPredicate}
      ${warehouseFilter}
      ${assignmentPredicate}
      ${fromPredicate}
      ${toPredicate}
  `;

  const offset = (filters.page - 1) * filters.limit;

  const [rows, counted] = await Promise.all([
    db.execute<WaveQueueRow>(sql`
      SELECT pl.id,
             pl.pick_number,
             pl.status,
             pl.warehouse_id,
             w.name AS warehouse_name,
             pl.assigned_to,
             u.name AS assigned_to_name,
             pl.claimed_at,
             pl.created_at,
             COALESCE(agg.order_count, 0)::int AS order_count,
             COALESCE(agg.line_count, 0)::int AS line_count,
             COALESCE(agg.lines_closed, 0)::int AS lines_closed,
             COALESCE(agg.open_exceptions, 0)::int AS open_exceptions
        FROM inv_pick_lists pl
        LEFT JOIN inv_warehouses w
          ON w.org_id = pl.org_id AND w.id = pl.warehouse_id
        -- Explicitly projected. The global users table still holds
        -- authentication secrets and legacy payroll columns, so nothing here
        -- reads it through a relation.
        LEFT JOIN users u ON u.id = pl.assigned_to
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT sol.so_id) AS order_count,
                 COUNT(*) AS line_count,
                 -- B5. The shared closed rule, not a second copy of it. This
                 -- read "exception_reason IS NOT NULL OR picked >= to_pick",
                 -- which now disagrees with the wave in two ways: a
                 -- WRONG_LOCATION line is still outstanding, and a damaged or
                 -- substituted one is not closed until a reviewer says so. The
                 -- board would have shown 4/4 beside a wave that refused to
                 -- complete.
                 COUNT(*) FILTER (WHERE ${PICK_LINE_CLOSED_SQL}) AS lines_closed,
                 COUNT(*) FILTER (
                   WHERE pll.exception_reason IS NOT NULL
                     AND pll.exception_status = 'OPEN'
                 ) AS open_exceptions
            FROM inv_pick_list_lines pll
            LEFT JOIN inv_so_lines sol
              ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
           WHERE pll.org_id = pl.org_id AND pll.pick_list_id = pl.id
        ) agg ON TRUE
       WHERE ${where}
       ORDER BY pl.created_at DESC, pl.id DESC
       LIMIT ${filters.limit} OFFSET ${offset}
    `),
    db.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM inv_pick_lists pl WHERE ${where}
    `),
  ]);

  const total = Number(counted[0]?.total ?? 0);

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      pickNumber: row.pick_number,
      status: row.status,
      warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
      warehouseName: row.warehouse_name,
      assignedTo: row.assigned_to,
      assignedToName: row.assigned_to_name,
      claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      createdAt: String(row.created_at),
      orderCount: Number(row.order_count),
      lineCount: Number(row.line_count),
      linesClosed: Number(row.lines_closed),
      openExceptions: Number(row.open_exceptions),
    })),
    total,
    page: filters.page,
    totalPages: Math.ceil(total / filters.limit),
  };
}
