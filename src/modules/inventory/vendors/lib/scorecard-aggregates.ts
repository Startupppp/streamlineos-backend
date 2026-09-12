import { sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { LeadTimeService, type LeadTimeEstimate } from "../../replenishment/forecast/lead-time.service";

/** Purchase orders whose delivery is finished, so their fill is final. */
const COMPLETED_PO_STATUSES = sql`('RECEIVED', 'CLOSED')`;

/** Purchase orders still owed to us. */
const OPEN_PO_STATUSES = sql`('DRAFT', 'SENT', 'PARTIAL')`;

export type PoAggregateRow = {
  vendor_id: number;
  currency: string;
  open_pos: number;
  spend: string;
};

type FillRow = {
  vendor_id: number;
  lines: number;
  lines_in_full: number;
  qty_ordered: string;
  qty_received: string;
};

type OnTimeRow = {
  vendor_id: number;
  measured: number;
  on_time: number;
};

type ReceiptQualityRow = {
  vendor_id: number;
  lines: number;
  rejected: number;
  discrepant: number;
  qty_received: string;
};

type ReturnRow = {
  vendor_id: number;
  lines: number;
  qty: string;
};

/** What the aggregates read through. The service hands over its own collaborators. */
export interface ScorecardAggregateDeps {
  readonly db: Db;
  readonly leadTimes: LeadTimeService;
}

/** Everything the scorecard assembly needs, already keyed by vendor. */
export interface ScorecardAggregates {
  readonly vendors: ReadonlyArray<{ id: number; currency: string }>;
  /** One entry per (vendor, currency) pair, because spend cannot be summed across them. */
  readonly poByVendor: ReadonlyMap<number, PoAggregateRow[]>;
  readonly fillByVendor: ReadonlyMap<number, FillRow>;
  readonly onTimeByVendor: ReadonlyMap<number, OnTimeRow>;
  readonly qualityByVendor: ReadonlyMap<number, ReceiptQualityRow>;
  readonly returnsByVendor: ReadonlyMap<number, ReturnRow>;
  readonly leadTimes: ReadonlyMap<number, LeadTimeEstimate>;
}

/**
 * C4 — every figure behind a batch of scorecards, in a fixed number of round
 * trips.
 *
 * Six queries whether the list holds one vendor or a hundred: five set-based
 * aggregates keyed on `vendor_id`, plus one batched lead-time read. Nothing
 * here scales with the size of the list, which is the property that stops a
 * scorecard column on a paginated vendor table from being an N+1, and it is
 * why this half is separated from the assembly at all — the assembly must loop
 * per vendor, and this must never. `vendor-performance.spec.ts` pins the count
 * by asking for one vendor and then a hundred and comparing.
 *
 * Every read is filtered to `org_id` in its own WHERE clause rather than left
 * to RLS: the per-PO receipt lookup this replaced carried no tenant predicate
 * at all.
 */
export async function readScorecardAggregates(
  deps: ScorecardAggregateDeps,
  orgId: string,
  vendorIds: readonly number[],
): Promise<ScorecardAggregates> {
  const ids = sql.join(
    vendorIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const anyVendor = sql`ANY(ARRAY[${ids}]::int[])`;

  const [vendorRows, poRows, fillRows, onTimeRows, qualityRows, returnRows, leadTimes] =
    await Promise.all([
      deps.db.execute<{ id: number; currency: string }>(sql`
          SELECT v.id, v.currency
          FROM inv_vendors v
          WHERE v.org_id = ${orgId} AND v.id = ${anyVendor}
        `),
      deps.db.execute<PoAggregateRow>(sql`
          SELECT po.vendor_id,
                 po.currency,
                 COUNT(*) FILTER (WHERE po.status IN ${OPEN_PO_STATUSES})::int AS open_pos,
                 COALESCE(
                   SUM(po.total) FILTER (WHERE po.status IN ${COMPLETED_PO_STATUSES}), 0
                 )::text AS spend
          FROM inv_purchase_orders po
          WHERE po.org_id = ${orgId} AND po.vendor_id = ${anyVendor}
          GROUP BY po.vendor_id, po.currency
        `),
      deps.db.execute<FillRow>(sql`
          SELECT po.vendor_id,
                 COUNT(*)::int AS lines,
                 COUNT(*) FILTER (WHERE l.quantity_received >= l.quantity)::int AS lines_in_full,
                 COALESCE(SUM(l.quantity), 0)::text AS qty_ordered,
                 COALESCE(SUM(LEAST(l.quantity_received, l.quantity)), 0)::text AS qty_received
          FROM inv_po_lines l
          JOIN inv_purchase_orders po ON po.org_id = l.org_id AND po.id = l.po_id
          WHERE l.org_id = ${orgId}
            AND po.vendor_id = ${anyVendor}
            AND po.status IN ${COMPLETED_PO_STATUSES}
          GROUP BY po.vendor_id
        `),
      deps.db.execute<OnTimeRow>(sql`
          SELECT po.vendor_id,
                 COUNT(*)::int AS measured,
                 COUNT(*) FILTER (WHERE r.first_receipt <= po.expected_delivery_date)::int AS on_time
          FROM inv_purchase_orders po
          JOIN LATERAL (
            SELECT MIN(g.received_date) AS first_receipt
            FROM inv_grns g
            WHERE g.org_id = po.org_id AND g.po_id = po.id AND g.status <> 'CANCELLED'
          ) r ON r.first_receipt IS NOT NULL
          WHERE po.org_id = ${orgId}
            AND po.vendor_id = ${anyVendor}
            AND po.expected_delivery_date IS NOT NULL
            AND po.status IN ${COMPLETED_PO_STATUSES}
          GROUP BY po.vendor_id
        `),
      deps.db.execute<ReceiptQualityRow>(sql`
          SELECT po.vendor_id,
                 COUNT(gl.id)::int AS lines,
                 COUNT(gl.id) FILTER (WHERE gl.quality_status = 'REJECTED')::int AS rejected,
                 COUNT(gl.id) FILTER (WHERE gl.discrepancy_reason IS NOT NULL)::int AS discrepant,
                 COALESCE(SUM(gl.quantity_received), 0)::text AS qty_received
          FROM inv_grn_lines gl
          JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
          JOIN inv_purchase_orders po ON po.org_id = g.org_id AND po.id = g.po_id
          WHERE gl.org_id = ${orgId}
            AND po.vendor_id = ${anyVendor}
            AND g.status <> 'CANCELLED'
          GROUP BY po.vendor_id
        `),
      deps.db.execute<ReturnRow>(sql`
          SELECT r.vendor_id,
                 COUNT(rl.id)::int AS lines,
                 COALESCE(SUM(rl.quantity), 0)::text AS qty
          FROM inv_vendor_return_lines rl
          JOIN inv_vendor_returns r ON r.org_id = rl.org_id AND r.id = rl.return_id
          WHERE rl.org_id = ${orgId}
            AND r.vendor_id = ${anyVendor}
            AND r.status = 'POSTED'
          GROUP BY r.vendor_id
        `),
      deps.leadTimes.vendorLeadTimes(orgId, vendorIds),
    ]);

  const poByVendor = new Map<number, PoAggregateRow[]>();
  for (const row of poRows) {
    const key = Number(row.vendor_id);
    const bucket = poByVendor.get(key);
    if (bucket) bucket.push(row);
    else poByVendor.set(key, [row]);
  }

  return {
    vendors: vendorRows,
    poByVendor,
    fillByVendor: new Map(fillRows.map((r) => [Number(r.vendor_id), r])),
    onTimeByVendor: new Map(onTimeRows.map((r) => [Number(r.vendor_id), r])),
    qualityByVendor: new Map(qualityRows.map((r) => [Number(r.vendor_id), r])),
    returnsByVendor: new Map(returnRows.map((r) => [Number(r.vendor_id), r])),
    leadTimes,
  };
}
