import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { addDec, cmpDec, divDec, mulDec } from "../stock-engine/decimal";
import { LeadTimeService } from "../replenishment/forecast/lead-time.service";
import type { VendorDeliveriesInput } from "./dto/inv-vendors.schemas";
import {
  readScorecardAggregates,
  type ScorecardAggregateDeps,
} from "./lib/scorecard-aggregates";
import { listVendorDeliveries, type VendorDelivery } from "./lib/vendor-deliveries";

/**
 * One row of the evidence behind a rate. Declared in `lib/vendor-deliveries.ts`
 * beside the only query that produces one, and re-exported here because the
 * controller names the service.
 */
export type { VendorDelivery };

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

/**
 * Below this a rate describes the lines it was computed from and nothing more.
 * A 50% rejection rate over two receipts is not a quality problem, it is two
 * receipts.
 */
const MIN_RATE_SAMPLE = 10;

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

  /** The aggregates read through this service's own injected collaborators. */
  private get aggregateDeps(): ScorecardAggregateDeps {
    return { db: this.db, leadTimes: this.leadTimes };
  }

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
   * The reads are `lib/scorecard-aggregates.ts`, which must not scale with the
   * size of the list; what is left here is the part that necessarily does — one
   * card assembled per vendor out of maps that are already keyed by vendor id.
   * Splitting on exactly that line is the point: a future edit that reached for
   * a per-vendor query would have to put it in the half whose own contract
   * forbids it.
   */
  async scorecardsFor(
    orgId: string,
    vendorIds: readonly number[],
  ): Promise<Map<number, VendorScorecard>> {
    const cards = new Map<number, VendorScorecard>();
    if (vendorIds.length === 0) return cards;

    const aggregates = await readScorecardAggregates(this.aggregateDeps, orgId, vendorIds);

    for (const vendor of aggregates.vendors) {
      const vendorId = Number(vendor.id);
      const fill = aggregates.fillByVendor.get(vendorId);
      const onTime = aggregates.onTimeByVendor.get(vendorId);
      const quality = aggregates.qualityByVendor.get(vendorId);
      const returned = aggregates.returnsByVendor.get(vendorId);

      let openPoCount = 0;
      let spend = "0.0000";
      const excludedCurrencies: string[] = [];
      for (const row of aggregates.poByVendor.get(vendorId) ?? []) {
        openPoCount += row.open_pos;
        // Adding rupees to dollars produces a number that is not money in any
        // currency. Only the vendor's own currency is summed; the rest are
        // named so the omission is visible rather than silent.
        if (row.currency === vendor.currency) spend = addDec(spend, row.spend);
        else if (cmpDec(row.spend, "0") !== 0) excludedCurrencies.push(row.currency);
      }

      const receivedLines = quality?.lines ?? 0;
      const leadTime = aggregates.leadTimes.get(vendorId);
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
   * @see lib/vendor-deliveries.ts
   */
  async deliveries(orgId: string, vendorId: number, filters: VendorDeliveriesInput) {
    return listVendorDeliveries(this.db, orgId, vendorId, filters);
  }
}
