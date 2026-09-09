import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invLaborRecords } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import {
  binChangesBetween,
  performanceOf,
  standardSecondsFor,
  type LaborPerformance,
} from "./labor-standard";
import type { LaborBoardQuery } from "./dto/labor.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface RecordLaborInput {
  warehouseId: number | null;
  taskKind: "PICK" | "PUTAWAY" | "COUNT" | "RECEIVE";
  taskId: number;
  taskLineId: number | null;
  userId: string;
  locationId: number | null;
  unitsDone: string;
  scanCount: number;
}

export interface LaborBoardRow extends LaborPerformance {
  userName: string | null;
}

/**
 * NEO-7 - what the floor actually did, and how it compares.
 *
 * Written from inside the command that finished the work, so a record cannot
 * exist for a confirmation that rolled back, and a confirmation cannot happen
 * without one. It is deliberately a *record*, not a running total: a total
 * maintained by increments is only ever as correct as its least careful writer,
 * which is the lesson `projection-definitions.ts` is a monument to.
 *
 * Recording never fails the command it is part of. A labour record is
 * observation; a picker whose confirmation was refused because the measurement
 * failed would rightly stop trusting the device.
 */
@Injectable()
export class LaborService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Record one completed line.
   *
   * `startedAt` is when this operator finished their previous line on the same
   * task, falling back to now-minus-the-standard for the first - a proxy, and
   * the alternative is asking a picker to press start, which nobody does twice.
   */
  async recordInTx(tx: Tx, orgId: string, input: RecordLaborInput): Promise<void> {
    const [previous] = await tx.execute<{ completed_at: Date; location_id: number | null }>(sql`
      SELECT completed_at, location_id
      FROM inv_labor_records
      WHERE org_id = ${orgId}
        AND user_id = ${input.userId}
        AND task_kind = ${input.taskKind}
        AND task_id = ${input.taskId}
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `);

    const distanceProxy = binChangesBetween(
      previous?.location_id === null || previous?.location_id === undefined
        ? null
        : Number(previous.location_id),
      input.locationId,
    );

    const standardSeconds = standardSecondsFor({
      scanCount: input.scanCount,
      distanceProxy,
      unitsDone: input.unitsDone,
    });

    // No previous line on this task means no window to measure, so the record
    // starts one standard's worth ago: the operator is scored exactly on
    // standard for their first line rather than as infinitely fast, which is what
    // a zero-length window would have said. Computed in SQL against the database
    // clock, so `started_at` and `completed_at` come from one source and the
    // CHECK that one follows the other cannot be tripped by a device's clock.
    await tx.execute(sql`
      INSERT INTO inv_labor_records
        (org_id, warehouse_id, task_kind, task_id, task_line_id, user_id, location_id,
         started_at, completed_at, units_done, scan_count, distance_proxy, standard_seconds)
      VALUES (
        ${orgId}, ${input.warehouseId}, ${input.taskKind}, ${input.taskId}, ${input.taskLineId},
        ${input.userId}, ${input.locationId},
        COALESCE(
          ${previous?.completed_at ?? null}::timestamp,
          now() - (${standardSeconds}::int * INTERVAL '1 second')
        ),
        now(), ${input.unitsDone}::numeric, ${input.scanCount}, ${distanceProxy}, ${standardSeconds}
      )
    `);
  }

  /**
   * The supervisor board: units per hour and performance against standard, by
   * person, over a window.
   *
   * Warehouse-scoped like every other operational read. Names come from the
   * global `users` table through an explicit minimal projection - never an
   * unprojected relation, which still carries authentication secrets
   * (backend/CLAUDE.md S3).
   */
  async board(orgId: string, userId: string, query: LaborBoardQuery): Promise<LaborBoardRow[]> {
    // `forUser` rather than a hand-rolled `IN`: the predicate builder is the one
    // named place a scope becomes SQL, and a copy of it here would be a copy that
    // drifts. A supervisor scoped to no warehouse sees nobody, not everybody.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) return [];

    const warehouseGate =
      query.warehouseId != null
        ? sql`AND lr.warehouse_id = ${query.warehouseId}`
        : sql`AND ${scope.warehouse(sql`lr.warehouse_id`)}`;

    const rows = await this.db.execute<{
      user_id: string; user_name: string | null; lines: number;
      units_done: string; actual_seconds: string; standard_seconds: string;
    }>(sql`
      SELECT lr.user_id,
             u.name AS user_name,
             COUNT(*)::int AS lines,
             COALESCE(SUM(lr.units_done), 0)::text AS units_done,
             COALESCE(SUM(EXTRACT(EPOCH FROM (lr.completed_at - lr.started_at))), 0)::text AS actual_seconds,
             COALESCE(SUM(lr.standard_seconds), 0)::text AS standard_seconds
      FROM inv_labor_records lr
      LEFT JOIN users u ON u.id = lr.user_id
      WHERE lr.org_id = ${orgId}
        AND lr.completed_at >= now() - (${query.windowDays}::int * INTERVAL '1 day')
        ${query.taskKind ? sql`AND lr.task_kind = ${query.taskKind}` : sql``}
        ${warehouseGate}
      GROUP BY lr.user_id, u.name
      ORDER BY COALESCE(SUM(lr.units_done), 0) DESC
      LIMIT 200
    `);

    return rows.map((row) =>
      Object.assign(
        performanceOf({
          userId: String(row.user_id),
          lines: Number(row.lines),
          unitsDone: Number(row.units_done),
          actualSeconds: Math.round(Number(row.actual_seconds)),
          standardSeconds: Math.round(Number(row.standard_seconds)),
        }),
        { userName: row.user_name === null ? null : String(row.user_name) },
      ),
    );
  }

  /** One person's recent lines, for the "why is this number what it is" question. */
  /**
   * One person's records, behind the SAME warehouse scope the board applies.
   *
   * This took `subjectUserId` straight from the query string and filtered on
   * `org_id` and that id alone — the caller's own identity never reached it.
   * `board()` above resolves `warehouseScope.forUser` and states in its own
   * comment that "a supervisor scoped to no warehouse sees nobody, not
   * everybody"; the drill-down BEHIND that board then answered for anybody, in
   * any warehouse, to any holder of `inventory:labor:read`.
   *
   * The aggregate was scoped and the detail was not, which is the worse way
   * round: this returns individual work — every task, start and finish time,
   * units, scans and bin changes for a named colleague. A supervisor for
   * warehouse A could read a picker who has only ever worked in warehouse B,
   * and a user with no warehouse at all — shown nothing by the board on purpose
   * — could read everyone by calling this route directly.
   *
   * Scoped on `warehouse` rather than `anyOf(warehouse, location)` deliberately:
   * the detail must be a subset of what the board counted, and the board gates
   * on `lr.warehouse_id`. Widening here would show rows the aggregate above
   * never included.
   *
   * Out of scope returns an empty list, not a 403 — the same answer as the
   * board, and it declines to confirm whether that person has records at all.
   */
  async recentFor(orgId: string, callerUserId: string, subjectUserId: string, limit: number) {
    const scope = await this.warehouseScope.forUser(orgId, callerUserId);
    if (scope.isEmpty) return [];

    return this.db
      .select({
        id: invLaborRecords.id,
        taskKind: invLaborRecords.taskKind,
        taskId: invLaborRecords.taskId,
        locationId: invLaborRecords.locationId,
        startedAt: invLaborRecords.startedAt,
        completedAt: invLaborRecords.completedAt,
        unitsDone: invLaborRecords.unitsDone,
        scanCount: invLaborRecords.scanCount,
        distanceProxy: invLaborRecords.distanceProxy,
        standardSeconds: invLaborRecords.standardSeconds,
      })
      .from(invLaborRecords)
      .where(
        and(
          eq(invLaborRecords.orgId, orgId),
          eq(invLaborRecords.userId, subjectUserId),
          scope.warehouse(sql`${invLaborRecords.warehouseId}`),
        ),
      )
      .orderBy(desc(invLaborRecords.completedAt), desc(invLaborRecords.id))
      .limit(limit);
  }
}
