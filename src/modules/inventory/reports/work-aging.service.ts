import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  WarehouseScopeService,
  type WarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import type { WorkAgingQueryInput } from "./dto/operations-metrics.schemas";
import { locationsInWarehouse } from "./warehouse-filter";

/**
 * The four buckets, in the order a floor supervisor reads them. Fixed and
 * exhaustive: a stage with nothing in it still reports all four with zero, so a
 * client renders the same four columns on a quiet morning as on a bad one.
 */
export const AGE_BAND_LABELS = ["0-4h", "4-24h", "24-72h", "72h+"] as const;
export type AgeBandLabel = (typeof AGE_BAND_LABELS)[number];

export interface AgeBand {
  label: AgeBandLabel;
  count: number;
  /** The oldest item in this band, in hours. `null` exactly when `count` is 0. */
  oldestHours: number | null;
}

export interface AgingStage {
  /** Open items in this stage as of the reference instant — the sum of the bands. */
  open: number;
  bands: AgeBand[];
}

export interface WorkAging {
  asOf: string;
  /**
   * The warehouses this answer covers, or `null` when the caller holds
   * `inventory:warehouses:scope-all` and the answer covers the organisation.
   *
   * Never omitted, and `[]` is a real value with a real meaning: the caller is
   * assigned no warehouse. That is the whole reason this field exists. On the
   * throughput report an operator assigned nothing and a warehouse with nothing
   * in it produce byte-identical responses, so the dashboard can only say "the
   * warehouse is idle" — which is wrong, unactionable, and indistinguishable
   * from the truth ("you are assigned no warehouse, ask an administrator").
   */
  scopedWarehouseIds: number[] | null;
  receipts: AgingStage;
  putaway: AgingStage;
  picking: AgingStage;
  pickExceptions: AgingStage;
  shipping: AgingStage;
}

/** The `stage` discriminator the query below tags each source with. */
type Stage = "receipts" | "putaway" | "picking" | "pickExceptions" | "shipping";

interface BandRow extends Record<string, unknown> {
  stage: string;
  band: string;
  count: number;
  /** Already rounded, in numeric, by the database. See `oldest_hours` below. */
  oldest_hours: string | null;
}

/**
 * How long the open work in each stage has been open.
 *
 * The counterpart to `OperationsMetricsService`, which answers what the
 * warehouse *did* over a window. This answers what it has *not done yet*, and
 * an aging report is the one shape a window cannot express: bounding it by a
 * `from` would hide the oldest item on the floor, which is the item the report
 * exists to surface.
 *
 * Scoping is `WarehouseScopeService` and nothing else — receiving through
 * `location(...)` because `inv_grns` names a location, everything else through
 * `warehouse(...)`, exactly as the throughput report already does. Pick
 * exceptions have no attribution of their own, so they are scoped through the
 * wave that owns the line.
 *
 * **`open` is the sum of the bands, by construction.** One row set produces
 * both, so a client can render a total beside its breakdown without them
 * disagreeing. It is a count of work that was open *and had already arrived* at
 * the reference instant; nothing here records when a status changed, so a
 * historical `asOf` narrows which items existed, not which were open then. That
 * is stated rather than hidden because a report that quietly implies it can
 * replay history is worse than one that cannot.
 */
@Injectable()
export class WorkAgingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async workAging(
    orgId: string,
    userId: string,
    query: WorkAgingQueryInput,
  ): Promise<WorkAging> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const scope = await this.warehouseScope.resolve(orgId, userId);

    // 404 rather than 403 on a warehouse the caller may not see, and on one that
    // is not this tenant's at all. A 403 would confirm the id exists.
    if (query.warehouseId !== undefined) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, query.warehouseId);
    }

    // The load-bearing case. Every predicate below would already return FALSE
    // for an empty scope and produce these same zeros, but the zeros alone are
    // the ambiguity this endpoint exists to remove: they are returned here
    // beside `scopedWarehouseIds: []` so the caller can tell "you are assigned
    // no warehouse" from "the warehouse is idle".
    if (scope !== null && scope.length === 0) return this.emptyAging(asOf, []);

    const rows = await this.db.execute<BandRow>(
      this.agingQuery(orgId, asOf, scope, query.warehouseId),
    );

    return {
      asOf,
      scopedWarehouseIds: scope,
      receipts: this.stageFrom(rows, "receipts"),
      putaway: this.stageFrom(rows, "putaway"),
      picking: this.stageFrom(rows, "picking"),
      pickExceptions: this.stageFrom(rows, "pickExceptions"),
      shipping: this.stageFrom(rows, "shipping"),
    };
  }

  /**
   * One statement over all five sources.
   *
   * A query per stage would be five round trips for a dashboard tile, and — the
   * reason that matters more — five copies of the band boundaries. The bucket
   * edges are the one thing every stage must agree on, so they appear once.
   */
  private agingQuery(
    orgId: string,
    asOf: string,
    scope: WarehouseScope,
    warehouseId: number | undefined,
  ): SQL {
    const inScopeWarehouse = (column: SQL): SQL =>
      this.warehouseScope.warehousePredicate(scope, column);
    const inScopeLocation = (column: SQL): SQL =>
      this.warehouseScope.locationPredicate(scope, column);

    /** The optional single-site filter, beside the scope predicate and never instead of it. */
    const onlyWarehouse = (column: SQL): SQL =>
      warehouseId === undefined ? sql`TRUE` : sql`${column} = ${warehouseId}`;
    const onlyWarehouseByLocation = (column: SQL): SQL =>
      warehouseId === undefined
        ? sql`TRUE`
        : sql`${column} IN ${locationsInWarehouse(orgId, warehouseId)}`;

    return sql`
      WITH ref AS (
        -- The instant ages are measured back from. Clamped to now() so that
        -- "as of today" does not measure from midnight tonight and report every
        -- task as up to a day older than it is; a past day measures from its
        -- end, which is what "as of the 3rd" means.
        SELECT LEAST(now(), (${asOf}::date + INTERVAL '1 day')::timestamptz) AS at
      ),
      work AS (
        SELECT 'receipts'::text AS stage,
               -- Numeric throughout. EXTRACT gives numeric, the division stays
               -- numeric, and the ROUND below happens in the database — so the
               -- only thing JavaScript does to this figure is read an already
               -- rounded decimal string.
               EXTRACT(EPOCH FROM (r.at - g.received_date::timestamp))::numeric / 3600
                 AS age_hours
          FROM inv_grns g
          CROSS JOIN ref r
         WHERE g.org_id = ${orgId}
           AND g.status IN ('DRAFT', 'COUNTING', 'QUALITY_REVIEW')
           AND g.received_date::timestamp <= r.at
           -- inv_grns names a location, not a warehouse; the scope resolves it
           -- through inv_locations exactly as listGrns does.
           AND ${inScopeLocation(sql`g.location_id`)}
           AND ${onlyWarehouseByLocation(sql`g.location_id`)}

        UNION ALL

        SELECT 'putaway'::text,
               EXTRACT(EPOCH FROM (r.at - t.created_at))::numeric / 3600
          FROM inv_putaway_tasks t
          CROSS JOIN ref r
         WHERE t.org_id = ${orgId}
           AND t.status IN ('PENDING', 'IN_PROGRESS')
           AND t.created_at <= r.at
           AND ${inScopeWarehouse(sql`t.warehouse_id`)}
           AND ${onlyWarehouse(sql`t.warehouse_id`)}

        UNION ALL

        SELECT 'picking'::text,
               EXTRACT(EPOCH FROM (r.at - p.created_at))::numeric / 3600
          FROM inv_pick_lists p
          CROSS JOIN ref r
         WHERE p.org_id = ${orgId}
           AND p.status IN ('PENDING', 'IN_PROGRESS')
           AND p.created_at <= r.at
           AND ${inScopeWarehouse(sql`p.warehouse_id`)}
           AND ${onlyWarehouse(sql`p.warehouse_id`)}

        UNION ALL

        -- A pick line carries no warehouse of its own, so it is scoped through
        -- the wave that owns it. Joined on (org_id, id), which is the composite
        -- the table is keyed by.
        SELECT 'pickExceptions'::text,
               EXTRACT(EPOCH FROM (r.at - pll.exception_reported_at))::numeric / 3600
          FROM inv_pick_list_lines pll
          JOIN inv_pick_lists pl
            ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
          CROSS JOIN ref r
         WHERE pll.org_id = ${orgId}
           AND pll.exception_status = 'OPEN'
           -- Every OPEN exception is stamped when it is reported, and the 0543
           -- backfill closed the legacy rows that predate the column as
           -- RESOLVED, so this drops no live work. It is asserted rather than
           -- assumed because an un-anchored row cannot be aged at all.
           AND pll.exception_reported_at IS NOT NULL
           AND pll.exception_reported_at <= r.at
           AND ${inScopeWarehouse(sql`pl.warehouse_id`)}
           AND ${onlyWarehouse(sql`pl.warehouse_id`)}

        UNION ALL

        -- Packed or labelled and still on the dock. The null shipped_at matters
        -- as much as the status: a shipment the carrier has taken is not work.
        SELECT 'shipping'::text,
               EXTRACT(EPOCH FROM (r.at - s.created_at))::numeric / 3600
          FROM inv_shipments s
          CROSS JOIN ref r
         WHERE s.org_id = ${orgId}
           AND s.status IN ('PACKED', 'LABEL_CREATED')
           AND s.shipped_at IS NULL
           AND s.created_at <= r.at
           AND ${inScopeWarehouse(sql`s.warehouse_id`)}
           AND ${onlyWarehouse(sql`s.warehouse_id`)}
      )
      SELECT stage,
             CASE
               WHEN age_hours < 4 THEN '0-4h'
               WHEN age_hours < 24 THEN '4-24h'
               WHEN age_hours < 72 THEN '24-72h'
               ELSE '72h+'
             END AS band,
             COUNT(*)::int AS count,
             ROUND(MAX(age_hours), 2)::text AS oldest_hours
        FROM work
       GROUP BY 1, 2
    `;
  }

  private stageFrom(rows: readonly BandRow[], stage: Stage): AgingStage {
    const bands: AgeBand[] = AGE_BAND_LABELS.map((label) => {
      const row = rows.find((r) => r.stage === stage && r.band === label);
      return {
        label,
        count: row ? Number(row.count) : 0,
        // The database rounded this, in numeric, to two decimals. Reading the
        // decimal string is the single conversion; nothing here re-rounds a
        // float it computed itself.
        oldestHours: row && row.oldest_hours !== null ? Number(row.oldest_hours) : null,
      };
    });

    return { open: bands.reduce((total, band) => total + band.count, 0), bands };
  }

  private emptyAging(asOf: string, scopedWarehouseIds: number[] | null): WorkAging {
    const stage = (): AgingStage => ({
      open: 0,
      bands: AGE_BAND_LABELS.map((label) => ({ label, count: 0, oldestHours: null })),
    });
    return {
      asOf,
      scopedWarehouseIds,
      receipts: stage(),
      putaway: stage(),
      picking: stage(),
      pickExceptions: stage(),
      shipping: stage(),
    };
  }
}
