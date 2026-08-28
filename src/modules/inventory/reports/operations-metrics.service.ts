import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { ThroughputQueryInput } from "./dto/operations-metrics.schemas";

export interface ThroughputMetrics {
  window: { from: string; to: string };
  receiving: {
    receipts: number;
    lines: number;
    discrepancyLines: number;
    /** Share of received lines that did not match, 0-1. */
    discrepancyRate: number;
  };
  picking: {
    linesConfirmed: number;
    exceptionLines: number;
    exceptionRate: number;
    wavesCompleted: number;
  };
  shipping: {
    shipped: number;
    delivered: number;
    /** Median hours from dispatch to the carrier's delivered scan. */
    medianTransitHours: number | null;
  };
}

/**
 * INV-210 — what the warehouse actually did, from the facts the rest of the
 * phase records.
 *
 * Every figure is a count or a percentile over rows that already exist; nothing
 * here maintains a counter. A denormalised throughput table would be faster and
 * would drift, and a dashboard that disagrees with the ledger is worse than no
 * dashboard -- people stop trusting both.
 *
 * Rates are reported alongside their numerators and denominators rather than
 * alone. "Discrepancy rate 50%" means something very different over four lines
 * than over four hundred, and a dashboard that shows only the percentage
 * invites the wrong conclusion on a quiet day.
 */
@Injectable()
export class OperationsMetricsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async throughput(
    orgId: string,
    userId: string,
    query: ThroughputQueryInput,
  ): Promise<ThroughputMetrics> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    // An operator assigned no warehouse sees no throughput, rather than the
    // whole building's.
    if (scope.isEmpty) {
      return this.empty(query);
    }

    const from = query.from;
    const to = query.to;

    const [receiving] = await this.db.execute<{
      receipts: number;
      lines: number;
      discrepancy_lines: number;
    }>(sql`
      SELECT COUNT(DISTINCT g.id)::int AS receipts,
             COUNT(gl.id)::int AS lines,
             COUNT(gl.id) FILTER (WHERE gl.discrepancy_reason IS NOT NULL)::int
               AS discrepancy_lines
      FROM inv_grns g
      JOIN inv_grn_lines gl ON gl.org_id = g.org_id AND gl.grn_id = g.id
      WHERE g.org_id = ${orgId}
        AND g.received_date >= ${from}
        AND g.received_date <= ${to}
    `);

    const [picking] = await this.db.execute<{
      lines_confirmed: number;
      exception_lines: number;
      waves_completed: number;
    }>(sql`
      SELECT COUNT(pl.id) FILTER (WHERE pl.quantity_picked > 0)::int AS lines_confirmed,
             COUNT(pl.id) FILTER (WHERE pl.exception_reason IS NOT NULL)::int
               AS exception_lines,
             COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'COMPLETED')::int
               AS waves_completed
      FROM inv_pick_lists p
      JOIN inv_pick_list_lines pl ON pl.org_id = p.org_id AND pl.pick_list_id = p.id
      WHERE p.org_id = ${orgId}
        AND p.created_at >= ${from}::date
        AND p.created_at < (${to}::date + 1)
        AND ${scope.warehouse(sql`p.warehouse_id`)}
    `);

    const [shipping] = await this.db.execute<{
      shipped: number;
      delivered: number;
      median_transit_hours: string | null;
    }>(sql`
      SELECT COUNT(*) FILTER (WHERE s.shipped_at IS NOT NULL)::int AS shipped,
             COUNT(*) FILTER (WHERE s.status = 'DELIVERED')::int AS delivered,
             -- Median rather than mean: one parcel lost for three weeks drags
             -- an average into uselessness, and the typical parcel is what a
             -- warehouse can act on.
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (d.occurred_at - s.shipped_at)) / 3600
             )::text AS median_transit_hours
      FROM inv_shipments s
      LEFT JOIN LATERAL (
        SELECT e.occurred_at
        FROM inv_shipment_status_events e
        WHERE e.org_id = s.org_id AND e.shipment_id = s.id AND e.status = 'DELIVERED'
        ORDER BY e.occurred_at
        LIMIT 1
      ) d ON true
      WHERE s.org_id = ${orgId}
        AND s.shipped_at >= ${from}::date
        AND s.shipped_at < (${to}::date + 1)
        AND ${scope.warehouse(sql`s.warehouse_id`)}
    `);

    const rate = (numerator: number, denominator: number) =>
      denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

    return {
      window: { from, to },
      receiving: {
        receipts: receiving?.receipts ?? 0,
        lines: receiving?.lines ?? 0,
        discrepancyLines: receiving?.discrepancy_lines ?? 0,
        discrepancyRate: rate(receiving?.discrepancy_lines ?? 0, receiving?.lines ?? 0),
      },
      picking: {
        linesConfirmed: picking?.lines_confirmed ?? 0,
        exceptionLines: picking?.exception_lines ?? 0,
        exceptionRate: rate(picking?.exception_lines ?? 0, picking?.lines_confirmed ?? 0),
        wavesCompleted: picking?.waves_completed ?? 0,
      },
      shipping: {
        shipped: shipping?.shipped ?? 0,
        delivered: shipping?.delivered ?? 0,
        medianTransitHours:
          shipping?.median_transit_hours == null
            ? null
            : Number(Number(shipping.median_transit_hours).toFixed(2)),
      },
    };
  }

  private empty(query: ThroughputQueryInput): ThroughputMetrics {
    return {
      window: { from: query.from, to: query.to },
      receiving: { receipts: 0, lines: 0, discrepancyLines: 0, discrepancyRate: 0 },
      picking: {
        linesConfirmed: 0,
        exceptionLines: 0,
        exceptionRate: 0,
        wavesCompleted: 0,
      },
      shipping: { shipped: 0, delivered: 0, medianTransitHours: null },
    };
  }
}
