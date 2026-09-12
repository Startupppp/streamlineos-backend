import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { inventoryCounters } from "./inventory-counters";

/**
 * G6 — the half of PRD §9 the database already knows.
 *
 * Counters measure things that happen; these measure things that *are*. Counting
 * negative stock in-process would make a second, worse copy of a number Postgres
 * can answer exactly — and the copy would drift the moment a second instance
 * ran, or a deploy reset it, or a row was fixed by hand. Every gauge here is a
 * query, so it is correct across restarts and across instances by construction.
 *
 * Each is tenant-scoped, because "reservation age is up" is only actionable if
 * you know whose, and because one noisy tenant otherwise hides everyone else's
 * silence.
 */

interface GaugeRow extends Record<string, unknown> {
  negative_levels: number;
  orphaned_reservations: number;
  oldest_active_reservation_hours: number | null;
  expired_unreleased_reservations: number;
  outbox_pending: number;
  outbox_dead: number;
  outbox_lag_seconds: number | null;
  import_jobs_failed: number;
}

export interface InventoryMetricsSnapshot {
  /** Things that are wrong right now and somebody has to fix. */
  readonly invariants: {
    /** A stock level with a negative bucket. Should be zero unless allowNegativeStock. */
    readonly negativeLevels: number;
    /** ACTIVE reservations whose source document no longer exists. */
    readonly orphanedReservations: number;
  };
  /** Things that are ageing and will become wrong. */
  readonly ageing: {
    readonly oldestActiveReservationHours: number | null;
    readonly expiredUnreleasedReservations: number;
  };
  /** Delivery health. */
  readonly outbox: {
    readonly pending: number;
    readonly dead: number;
    readonly lagSeconds: number | null;
  };
  readonly imports: { readonly failedJobs: number };
  /** In-process rates. Reset on deploy, which is stated rather than hidden. */
  readonly counters: Record<string, number>;
  readonly countersNote: string;
}

@Injectable()
export class InventoryMetricsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One round trip for every gauge.
   *
   * Deliberately one statement rather than eight: an operator endpoint that
   * costs eight queries per poll is a load source of its own, and the whole
   * point of the endpoint is to be safe to scrape often.
   */
  async snapshot(orgId: string): Promise<InventoryMetricsSnapshot> {
    const [row] = await this.db.execute<GaugeRow>(sql`
      SELECT
        (SELECT count(*)::int FROM inv_stock_levels
          WHERE org_id = ${orgId}
            AND (on_hand < 0 OR blocked_qty < 0 OR quality_hold_qty < 0)
        ) AS negative_levels,

        -- A reservation pointing at a sales order that is gone. The engine never
        -- creates one; it is the shape a bad delete or a failed compensation
        -- leaves behind, which is exactly why it is worth counting.
        (SELECT count(*)::int FROM inv_stock_reservations r
          WHERE r.org_id = ${orgId}
            AND r.status = 'ACTIVE'
            AND r.source_type = 'inv_sales_order'
            AND NOT EXISTS (
              SELECT 1 FROM inv_sales_orders so
              WHERE so.org_id = r.org_id AND so.id::text = r.source_id
            )
        ) AS orphaned_reservations,

        (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) / 3600
           FROM inv_stock_reservations
          WHERE org_id = ${orgId} AND status = 'ACTIVE'
        ) AS oldest_active_reservation_hours,

        -- Past its expiry and still holding stock: the leak the expiry sweep
        -- exists to close, and the number that says whether it is running.
        (SELECT count(*)::int FROM inv_stock_reservations
          WHERE org_id = ${orgId} AND status = 'ACTIVE'
            AND expires_at IS NOT NULL AND expires_at < now()
        ) AS expired_unreleased_reservations,

        (SELECT count(*)::int FROM outbox_events
          WHERE organization_id = ${orgId} AND delivery_state = 'PENDING'
        ) AS outbox_pending,

        (SELECT count(*)::int FROM outbox_events
          WHERE organization_id = ${orgId} AND delivery_state = 'DEAD'
        ) AS outbox_dead,

        -- Lag is the age of the OLDEST undelivered event, not the average: an
        -- average hides one stuck event behind a thousand fast ones, and a stuck
        -- event is the thing an operator needs to see.
        (SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))
           FROM outbox_events
          WHERE organization_id = ${orgId} AND delivery_state = 'PENDING'
        ) AS outbox_lag_seconds,

        (SELECT count(*)::int FROM inv_import_jobs
          WHERE org_id = ${orgId} AND status = 'FAILED'
        ) AS import_jobs_failed
    `);

    const num = (value: unknown): number => (value == null ? 0 : Number(value));
    const nullableNum = (value: unknown): number | null =>
      value == null ? null : Number(value);

    return {
      invariants: {
        negativeLevels: num(row?.negative_levels),
        orphanedReservations: num(row?.orphaned_reservations),
      },
      ageing: {
        oldestActiveReservationHours: nullableNum(row?.oldest_active_reservation_hours),
        expiredUnreleasedReservations: num(row?.expired_unreleased_reservations),
      },
      outbox: {
        pending: num(row?.outbox_pending),
        dead: num(row?.outbox_dead),
        lagSeconds: nullableNum(row?.outbox_lag_seconds),
      },
      imports: { failedJobs: num(row?.import_jobs_failed) },
      counters: inventoryCounters.snapshotFor(orgId),
      countersNote:
        "In-process counters. Per-instance and reset on deploy — read them as rates over a window, never as totals.",
    };
  }
}
