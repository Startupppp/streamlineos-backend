import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { describe as summarise } from "./safety-stock";

export interface LeadTimeEstimate {
  vendorId: number;
  observations: number;
  meanDays: number;
  stdDevDays: number;
  /**
   * The number to plan against. A mean lead time is met about half the time,
   * which is not what anybody means by "the lead time" -- p90 is the promise a
   * planner can actually keep.
   */
  p50Days: number;
  p90Days: number;
  /** Null when there is not enough history to say anything. */
  reliable: boolean;
  note?: string;
}

export interface FillRateEstimate {
  productVariantId: number;
  linesRequested: number;
  linesFilledInFull: number;
  quantityRequested: number;
  quantityFilled: number;
  /** Share of lines met in full, 0-1. */
  lineFillRate: number;
  /** Share of units met, 0-1. */
  unitFillRate: number;
  note?: string;
}

/** The most recent receipts any one estimate is built from. */
const OBSERVATION_WINDOW = 200;

/**
 * Three receipts is not a distribution. Below that the deviation is noise and
 * the p90 is just the slowest of a tiny sample.
 */
const MIN_RELIABLE_OBSERVATIONS = 3;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank. With a handful of observations, interpolating between two of
  // them invents precision the sample does not have.
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function estimateFrom(vendorId: number, days: readonly number[]): LeadTimeEstimate {
  if (days.length === 0) {
    return {
      vendorId,
      observations: 0,
      meanDays: 0,
      stdDevDays: 0,
      p50Days: 0,
      p90Days: 0,
      reliable: false,
      note: "No receipts on record for this vendor. Any lead time used for planning is a configured assumption, not a measurement.",
    };
  }

  const sorted = [...days].sort((a, b) => a - b);
  const stats = summarise(sorted);
  return {
    vendorId,
    observations: sorted.length,
    meanDays: stats.mean,
    stdDevDays: stats.stdDev,
    p50Days: percentile(sorted, 0.5),
    p90Days: percentile(sorted, 0.9),
    reliable: sorted.length >= MIN_RELIABLE_OBSERVATIONS,
    note:
      sorted.length < MIN_RELIABLE_OBSERVATIONS
        ? `Only ${sorted.length} receipt(s); the spread here is noise rather than a measured distribution.`
        : undefined,
  };
}

/**
 * INV-304 — how long a supplier actually takes, and how often demand was met.
 *
 * Both are measured from what happened rather than from what was configured.
 * A vendor record's lead time is a promise; the receipts are the evidence, and
 * planning against the promise is how a warehouse discovers its supplier is
 * three days slower than the contract only when it stocks out.
 *
 * C4 made this the only place a lead-time observation is defined. There were
 * three derivations of the same idea: this one, a per-variant copy inside
 * `SafetyStockPolicyService`, and a third inside the vendor scorecard that
 * measured from `sent_at` to the first receipt rather than from the order date,
 * so the scorecard and the lead-time report answered the same question with
 * different numbers. One observation, one definition:
 *
 *   an observation is `received_date - order_date`, in days, on a receipt that
 *   was not abandoned.
 *
 * A CANCELLED receipt is excluded because it is not a delivery — the row is
 * kept as a record of a delivery somebody walked away from. Everything short of
 * POSTED *is* counted: the goods physically arrived, and gating on POSTED would
 * make a supplier's measured lead time depend on how fast our own warehouse
 * does its paperwork.
 */
@Injectable()
export class LeadTimeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async vendorLeadTime(orgId: string, vendorId: number): Promise<LeadTimeEstimate> {
    const byVendor = await this.vendorLeadTimes(orgId, [vendorId]);
    return byVendor.get(vendorId) ?? estimateFrom(vendorId, []);
  }

  /**
   * Every vendor's lead time in one round trip.
   *
   * The scorecard reads this for a page of vendors at a time, and calling
   * `vendorLeadTime` in a loop is the N+1 that shape invites. The window is
   * applied per vendor inside the query, so one slow supplier with a thousand
   * receipts cannot crowd another out of its own sample.
   */
  async vendorLeadTimes(
    orgId: string,
    vendorIds: readonly number[],
  ): Promise<Map<number, LeadTimeEstimate>> {
    const byVendor = new Map<number, LeadTimeEstimate>();
    if (vendorIds.length === 0) return byVendor;

    const ids = sql.join(
      vendorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await this.db.execute<{ vendor_id: number; days: string }>(sql`
      SELECT vendor_id, days
      FROM (
        SELECT po.vendor_id AS vendor_id,
               EXTRACT(EPOCH FROM (g.received_date::timestamp - po.order_date::timestamp)) / 86400
                 AS days,
               ROW_NUMBER() OVER (
                 PARTITION BY po.vendor_id ORDER BY g.received_date DESC, g.id DESC
               ) AS recency
        FROM inv_grns g
        JOIN inv_purchase_orders po ON po.org_id = g.org_id AND po.id = g.po_id
        WHERE g.org_id = ${orgId}
          AND po.vendor_id = ANY(ARRAY[${ids}]::int[])
          AND g.status <> 'CANCELLED'
          AND g.received_date >= po.order_date
      ) observed
      WHERE recency <= ${OBSERVATION_WINDOW}
    `);

    const daysByVendor = new Map<number, number[]>();
    for (const row of rows) {
      const days = Number(row.days);
      if (!Number.isFinite(days) || days < 0) continue;
      const bucket = daysByVendor.get(Number(row.vendor_id));
      if (bucket) bucket.push(days);
      else daysByVendor.set(Number(row.vendor_id), [days]);
    }

    for (const vendorId of vendorIds)
      byVendor.set(vendorId, estimateFrom(vendorId, daysByVendor.get(vendorId) ?? []));

    return byVendor;
  }

  /**
   * The same observation, grouped by what was bought rather than by who sold
   * it. Safety stock needs the spread of lead times for one SKU across every
   * supplier that ships it, which is a different sample from any one vendor's.
   * It is the same definition of an observation, which is why it lives here.
   */
  async variantLeadTimeDays(orgId: string, productVariantId: number): Promise<number[]> {
    const rows = await this.db.execute<{ days: string }>(sql`
      SELECT EXTRACT(EPOCH FROM (g.received_date::timestamp - po.order_date::timestamp)) / 86400
             AS days
      FROM inv_grn_lines gl
      JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
      JOIN inv_po_lines pol ON pol.org_id = gl.org_id AND pol.id = gl.po_line_id
      JOIN inv_purchase_orders po ON po.org_id = pol.org_id AND po.id = pol.po_id
      WHERE gl.org_id = ${orgId}
        AND pol.product_variant_id = ${productVariantId}
        AND g.status <> 'CANCELLED'
        AND g.received_date >= po.order_date
      ORDER BY g.received_date DESC
      LIMIT 50
    `);
    return rows.map((r) => Number(r.days)).filter((d) => Number.isFinite(d) && d >= 0);
  }

  /**
   * Fill rate over sales order lines.
   *
   * Two numbers, because they answer different questions and diverge exactly
   * when it matters. Line fill rate is what a customer experiences -- an order
   * short one item is a short order. Unit fill rate is what the warehouse
   * moved. A month where 99% of units shipped but 40% of orders were incomplete
   * is a bad month, and only the line rate says so.
   *
   * This is the *customer* fill rate: did we meet demand. The supplier fill
   * rate — did the vendor ship what we ordered — is a different measurement over
   * purchase order lines and lives on the vendor scorecard.
   */
  async fillRate(
    orgId: string,
    productVariantId: number,
    window: { from: string; to: string },
  ): Promise<FillRateEstimate> {
    const [row] = await this.db.execute<{
      lines_requested: number;
      lines_filled: number;
      qty_requested: string;
      qty_filled: string;
    }>(sql`
      SELECT COUNT(*)::int AS lines_requested,
             COUNT(*) FILTER (
               WHERE COALESCE(picked.qty, 0) >= l.quantity
             )::int AS lines_filled,
             COALESCE(SUM(l.quantity), 0)::text AS qty_requested,
             COALESCE(SUM(LEAST(COALESCE(picked.qty, 0), l.quantity)), 0)::text AS qty_filled
      FROM inv_so_lines l
      JOIN inv_sales_orders so ON so.org_id = l.org_id AND so.id = l.so_id
      LEFT JOIN LATERAL (
        SELECT SUM(pl.quantity_picked) AS qty
        FROM inv_pick_list_lines pl
        WHERE pl.org_id = l.org_id AND pl.so_line_id = l.id
      ) picked ON true
      WHERE l.org_id = ${orgId}
        AND l.product_variant_id = ${productVariantId}
        AND so.order_date >= ${window.from}
        AND so.order_date <= ${window.to}
    `);

    const linesRequested = row?.lines_requested ?? 0;
    const linesFilled = row?.lines_filled ?? 0;
    const qtyRequested = Number(row?.qty_requested ?? 0);
    const qtyFilled = Number(row?.qty_filled ?? 0);

    const ratio = (numerator: number, denominator: number) =>
      denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

    return {
      productVariantId,
      linesRequested,
      linesFilledInFull: linesFilled,
      quantityRequested: qtyRequested,
      quantityFilled: qtyFilled,
      lineFillRate: ratio(linesFilled, linesRequested),
      unitFillRate: ratio(qtyFilled, qtyRequested),
      // A rate over three orders is a fact about three orders.
      note:
        linesRequested === 0
          ? "No demand in this window, so there is no fill rate to report."
          : linesRequested < 10
            ? `Only ${linesRequested} line(s) in this window; the rate is arithmetic rather than a trend.`
            : undefined,
    };
  }
}
