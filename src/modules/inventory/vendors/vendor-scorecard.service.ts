import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { addDec, cmpDec, divDec, mulDec } from "../stock-engine/decimal";
import { LeadTimeService } from "../replenishment/forecast/lead-time.service";
import type { VendorDeliveriesInput } from "./dto/inv-vendors.schemas";

/**
 * A rate reported the only honest way: beside the sample it rests on.
 *
 * `percent` is null when the denominator is zero. Zero percent and "there is
 * nothing to measure" are opposite claims about a supplier, and a scorecard
 * that renders both as 0.0% tells a buyer their worst vendor is perfect.
 */
export interface ScorecardRate {
  /** Percent to two decimals, exact. Null when there is nothing to measure. */
  percent: string | null;
  numerator: string;
  denominator: string;
  /** Observations behind the rate — receipts, lines or orders. */
  sampleSize: number;
  /** False when the sample is too small to read as anything but arithmetic. */
  sufficient: boolean;
}

export interface VendorScorecard {
  vendorId: number;
  leadTime: {
    observations: number;
    meanDays: number;
    stdDevDays: number;
    p50Days: number;
    p90Days: number;
    reliable: boolean;
    note?: string;
  };
  onTime: ScorecardRate;
  lineFill: ScorecardRate;
  unitFill: ScorecardRate;
  returns: ScorecardRate;
  rejection: ScorecardRate;
  discrepancy: ScorecardRate;
  openPoCount: number;
  spend: {
    amount: string;
    currency: string;
    /** Currencies excluded from `amount` because summing them would be a lie. */
    excludedCurrencies: string[];
  };
  notes: string[];
}

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
 * Below this a rate describes the lines it was computed from and nothing more.
 * A 50% rejection rate over two receipts is not a quality problem, it is two
 * receipts.
 */
const MIN_RATE_SAMPLE = 10;

/** Purchase orders whose delivery is finished, so their fill is final. */
const COMPLETED_PO_STATUSES = sql`('RECEIVED', 'CLOSED')`;

/** Purchase orders still owed to us. */
const OPEN_PO_STATUSES = sql`('DRAFT', 'SENT', 'PARTIAL')`;

/** Exact 4dp → 2dp, half-up. Never via `Number`: these are decimals, not floats. */
function scaleTo2(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  const padded = `${frac}0000`.slice(0, 4);
  const hundredths = BigInt(whole || "0") * 100n + BigInt(padded.slice(0, 2) || "0");
  const rounded = Number(padded[2]) >= 5 ? hundredths + 1n : hundredths;
  const sign = negative && rounded !== 0n ? "-" : "";
  return `${sign}${rounded / 100n}.${(rounded % 100n).toString().padStart(2, "0")}`;
}

function rateOf(numerator: string, denominator: string, sampleSize: number): ScorecardRate {
  const measurable = cmpDec(denominator, "0") !== 0;
  return {
    // Multiply before dividing: 5/6 rounded to four places and then scaled is
    // 83.33 by luck, and 1/3 of a percent is lost on numbers that are not.
    percent: measurable ? scaleTo2(divDec(mulDec(numerator, "100"), denominator)) : null,
    numerator,
    denominator,
    sampleSize,
    sufficient: sampleSize >= MIN_RATE_SAMPLE,
  };
}

function countRate(numerator: number, denominator: number): ScorecardRate {
  return rateOf(String(numerator), String(denominator), denominator);
}

type PoAggregateRow = {
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

/**
 * C4 — the supplier scorecard, derived once.
 *
 * What this replaces: `InvVendorsService.getVendorPerformance` computed six
 * numbers inline, three of which were wrong in ways nothing would have caught.
 * It averaged `sent_at → first receipt` for a lead time, which is a different
 * measurement from the one `LeadTimeService` reports two clicks away; it ran
 * `parseFloat` over `numeric(18,4)` quantities; it counted every receipt and
 * every vendor return regardless of whether the document had been abandoned;
 * and its per-PO receipt lookup carried no `org_id` predicate at all.
 *
 * No composite grade. A single letter hides which of five things went wrong,
 * and the point of a scorecard is deciding what to say to the supplier. Every
 * rate is reported beside the count it was computed from instead.
 *
 * The batch method is the primitive and the single-vendor read is a special
 * case of it, because the callers that matter are plural: the supplier-delay
 * briefing scores every delayed vendor in one breath, and a per-vendor loop
 * there was seven queries per supplier.
 */
@Injectable()
export class VendorScorecardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly leadTimes: LeadTimeService,
  ) {}

  async scorecard(orgId: string, vendorId: number): Promise<VendorScorecard> {
    const cards = await this.scorecardsFor(orgId, [vendorId]);
    const card = cards.get(vendorId);
    // A vendor in another tenant is absent, not forbidden — a 403 here would
    // confirm the id exists.
    if (!card) throw new NotFoundException("Vendor not found");
    return card;
  }

  /**
   * Every scorecard in a fixed number of round trips.
   *
   * Six queries whether the list holds one vendor or a hundred: five set-based
   * aggregates keyed on `vendor_id`, plus one batched lead-time read. Nothing
   * here scales with the size of the list, which is the property that stops a
   * scorecard column on a paginated vendor table from being an N+1.
   */
  async scorecardsFor(
    orgId: string,
    vendorIds: readonly number[],
  ): Promise<Map<number, VendorScorecard>> {
    const cards = new Map<number, VendorScorecard>();
    if (vendorIds.length === 0) return cards;

    const ids = sql.join(
      vendorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const anyVendor = sql`ANY(ARRAY[${ids}]::int[])`;

    const [vendorRows, poRows, fillRows, onTimeRows, qualityRows, returnRows, leadTimes] =
      await Promise.all([
        this.db.execute<{ id: number; currency: string }>(sql`
          SELECT v.id, v.currency
          FROM inv_vendors v
          WHERE v.org_id = ${orgId} AND v.id = ${anyVendor}
        `),
        this.db.execute<PoAggregateRow>(sql`
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
        this.db.execute<FillRow>(sql`
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
        this.db.execute<OnTimeRow>(sql`
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
        this.db.execute<ReceiptQualityRow>(sql`
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
        this.db.execute<ReturnRow>(sql`
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
        this.leadTimes.vendorLeadTimes(orgId, vendorIds),
      ]);

    const fillByVendor = new Map(fillRows.map((r) => [Number(r.vendor_id), r]));
    const onTimeByVendor = new Map(onTimeRows.map((r) => [Number(r.vendor_id), r]));
    const qualityByVendor = new Map(qualityRows.map((r) => [Number(r.vendor_id), r]));
    const returnsByVendor = new Map(returnRows.map((r) => [Number(r.vendor_id), r]));
    const poByVendor = new Map<number, PoAggregateRow[]>();
    for (const row of poRows) {
      const key = Number(row.vendor_id);
      const bucket = poByVendor.get(key);
      if (bucket) bucket.push(row);
      else poByVendor.set(key, [row]);
    }

    for (const vendor of vendorRows) {
      const vendorId = Number(vendor.id);
      const fill = fillByVendor.get(vendorId);
      const onTime = onTimeByVendor.get(vendorId);
      const quality = qualityByVendor.get(vendorId);
      const returned = returnsByVendor.get(vendorId);

      let openPoCount = 0;
      let spend = "0.0000";
      const excludedCurrencies: string[] = [];
      for (const row of poByVendor.get(vendorId) ?? []) {
        openPoCount += row.open_pos;
        // Adding rupees to dollars produces a number that is not money in any
        // currency. Only the vendor's own currency is summed; the rest are
        // named so the omission is visible rather than silent.
        if (row.currency === vendor.currency) spend = addDec(spend, row.spend);
        else if (cmpDec(row.spend, "0") !== 0) excludedCurrencies.push(row.currency);
      }

      const receivedLines = quality?.lines ?? 0;
      const leadTime = leadTimes.get(vendorId);
      const notes: string[] = [];
      if (receivedLines === 0)
        notes.push(
          "This vendor has never delivered against a purchase order. Every rate here has no denominator — that is not the same as a perfect record.",
        );
      else if (receivedLines < MIN_RATE_SAMPLE)
        notes.push(
          `Rates are computed over ${receivedLines} received line(s) and describe those lines rather than a trend.`,
        );
      if (leadTime?.note) notes.push(leadTime.note);
      if (excludedCurrencies.length > 0)
        notes.push(
          `Spend excludes purchase orders in ${[...new Set(excludedCurrencies)].sort().join(", ")}, which cannot be added to ${vendor.currency}.`,
        );

      cards.set(vendorId, {
        vendorId,
        leadTime: {
          observations: leadTime?.observations ?? 0,
          meanDays: leadTime?.meanDays ?? 0,
          stdDevDays: leadTime?.stdDevDays ?? 0,
          p50Days: leadTime?.p50Days ?? 0,
          p90Days: leadTime?.p90Days ?? 0,
          reliable: leadTime?.reliable ?? false,
          note: leadTime?.note,
        },
        onTime: countRate(onTime?.on_time ?? 0, onTime?.measured ?? 0),
        lineFill: countRate(fill?.lines_in_full ?? 0, fill?.lines ?? 0),
        unitFill: rateOf(fill?.qty_received ?? "0", fill?.qty_ordered ?? "0", fill?.lines ?? 0),
        returns: rateOf(
          returned?.qty ?? "0",
          quality?.qty_received ?? "0",
          returned?.lines ?? 0,
        ),
        rejection: countRate(quality?.rejected ?? 0, receivedLines),
        discrepancy: countRate(quality?.discrepant ?? 0, receivedLines),
        openPoCount,
        spend: {
          amount: spend,
          currency: vendor.currency,
          excludedCurrencies: [...new Set(excludedCurrencies)].sort(),
        },
        notes,
      });
    }

    return cards;
  }

  /**
   * The rows every rate above was computed from.
   *
   * A rate nobody can walk back to its documents is a number to argue with
   * rather than act on, so each row carries the purchase order, the receipts
   * behind it and whether that one delivery was late. Two round trips at any
   * page size: the per-PO receipt and line rollups are laterals, not a query
   * per row.
   */
  async deliveries(orgId: string, vendorId: number, filters: VendorDeliveriesInput) {
    const { page, limit } = filters;
    const offset = (page - 1) * limit;

    const [rows, countRows] = await Promise.all([
      this.db.execute<{
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
      this.db.execute<{ total: number }>(sql`
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
}
