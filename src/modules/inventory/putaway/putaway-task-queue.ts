import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { ListPutawayTasksInput } from "./dto/putaway.schemas";

/** A task header as the workbench lists it. */
export interface PutawayTaskSummary {
  id: number;
  taskNumber: string;
  status: string;
  warehouseId: number;
  warehouseName: string | null;
  grnId: number | null;
  grnNumber: string | null;
  fromLocationId: number;
  fromLocationCode: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  claimedAt: string | null;
  createdAt: string;
  lineCount: number;
  linesClosed: number;
  quarantineLineCount: number;
}

/** One line of a task, as the SQL projection reads it. */
export interface PutawayTaskLineRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  sku: string;
  variant_name: string;
  lot_id: number | null;
  lot_number: string | null;
  serial_id: number | null;
  serial_number: string | null;
  quantity: string;
  quantity_moved: string;
  disposition: string;
  to_location_id: number | null;
  to_location_code: string | null;
}

interface QueueRow extends Record<string, unknown> {
  id: number;
  task_number: string;
  status: string;
  warehouse_id: number;
  warehouse_name: string | null;
  grn_id: number | null;
  grn_number: string | null;
  from_location_id: number;
  from_location_code: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  claimed_at: string | null;
  created_at: string;
  line_count: number;
  lines_closed: number;
  quarantine_line_count: number;
}

/**
 * B3, item 3 — the queue a putaway operator works.
 *
 * Warehouse-scoped like every other inventory list: a task is attributed to its
 * warehouse, and an operator assigned to one building has no business seeing
 * another's walks.
 *
 * **`assignment` is a view, never a user id.** A query that could name the
 * operator could read somebody else's queue; "whose tasks am I looking at" is
 * answered from the token.
 *
 * **Not cached.** The queue's whole value is being current — a task someone else
 * claimed a second ago must not still read as available — and a list this
 * volatile behind a cache is a workbench that lies. That is also why this
 * service does not appear in the scoped-cache-key ratchet: there is no key.
 *
 * The per-task counts come from one LATERAL aggregate rather than a query per
 * row: at 25 rows a page that is 25 round trips a keystroke.
 */
export async function queryPutawayQueue(
  db: Db,
  orgId: string,
  userId: string,
  filters: ListPutawayTasksInput,
  warehousePredicate: (column: SQL) => SQL,
): Promise<{
  items: PutawayTaskSummary[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const statusPredicate = filters.status ? sql`AND t.status = ${filters.status}` : sql``;
  const warehouseFilter = filters.warehouseId
    ? sql`AND t.warehouse_id = ${filters.warehouseId}`
    : sql``;
  const assignmentPredicate =
    filters.assignment === "MINE"
      ? sql`AND t.assigned_to = ${userId}`
      : filters.assignment === "UNCLAIMED"
        ? sql`AND t.assigned_to IS NULL`
        : sql``;

  const where = sql`
    t.org_id = ${orgId}
      AND ${warehousePredicate(sql`t.warehouse_id`)}
      ${statusPredicate}
      ${warehouseFilter}
      ${assignmentPredicate}
  `;

  const offset = (filters.page - 1) * filters.limit;

  const [rows, counted] = await Promise.all([
    db.execute<QueueRow>(sql`
      SELECT t.id,
             t.task_number,
             t.status,
             t.warehouse_id,
             w.name AS warehouse_name,
             t.grn_id,
             g.grn_number,
             t.from_location_id,
             src.code AS from_location_code,
             t.assigned_to,
             u.name AS assigned_to_name,
             t.claimed_at,
             t.created_at,
             COALESCE(agg.line_count, 0)::int AS line_count,
             COALESCE(agg.lines_closed, 0)::int AS lines_closed,
             COALESCE(agg.quarantine_line_count, 0)::int AS quarantine_line_count
        FROM inv_putaway_tasks t
        LEFT JOIN inv_warehouses w
          ON w.org_id = t.org_id AND w.id = t.warehouse_id
        LEFT JOIN inv_grns g
          ON g.org_id = t.org_id AND g.id = t.grn_id
        LEFT JOIN inv_locations src
          ON src.org_id = t.org_id AND src.id = t.from_location_id
        -- Explicitly projected. The global users table still holds
        -- authentication secrets and legacy payroll columns, so nothing here
        -- reads it through a relation.
        LEFT JOIN users u ON u.id = t.assigned_to
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS line_count,
                 COUNT(*) FILTER (
                   WHERE tl.quantity_moved >= tl.quantity
                 ) AS lines_closed,
                 COUNT(*) FILTER (WHERE tl.disposition = 'QUARANTINE') AS quarantine_line_count
            FROM inv_putaway_task_lines tl
           WHERE tl.org_id = t.org_id AND tl.task_id = t.id
        ) agg ON TRUE
       WHERE ${where}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${filters.limit} OFFSET ${offset}
    `),
    db.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM inv_putaway_tasks t WHERE ${where}
    `),
  ]);

  const total = Number(counted[0]?.total ?? 0);

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      taskNumber: row.task_number,
      status: row.status,
      warehouseId: Number(row.warehouse_id),
      warehouseName: row.warehouse_name,
      grnId: row.grn_id === null ? null : Number(row.grn_id),
      grnNumber: row.grn_number,
      fromLocationId: Number(row.from_location_id),
      fromLocationCode: row.from_location_code,
      assignedTo: row.assigned_to,
      assignedToName: row.assigned_to_name,
      claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      createdAt: String(row.created_at),
      lineCount: Number(row.line_count),
      linesClosed: Number(row.lines_closed),
      quarantineLineCount: Number(row.quarantine_line_count),
    })),
    total,
    page: filters.page,
    totalPages: Math.ceil(total / filters.limit),
  };
}
