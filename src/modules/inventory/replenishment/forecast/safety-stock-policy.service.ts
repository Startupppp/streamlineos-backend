import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService } from "./demand-baseline.service";
import { classifyDemand, type DemandCategory } from "./demand-shape";
import { describe as summarise, safetyStock, type SafetyStockResult } from "./safety-stock";

export interface SafetyStockPolicyResult {
  productVariantId: number;
  serviceLevel: number;
  demandCategory: DemandCategory;
  demand: { mean: number; stdDev: number; periods: number };
  leadTime: { periods: number; stdDev: number; observations: number };
  /** Null when the model does not apply to this demand shape. */
  policy: SafetyStockResult | null;
  applicable: boolean;
  notes: string[];
}

/**
 * INV-303 — safety stock over real demand and real lead times.
 *
 * The guard is the interesting part. A z-score times a standard deviation is a
 * statement about a bell curve, and demand that is zero four weeks in five is
 * not remotely one. The arithmetic still produces a number, and the number
 * still looks like a service level, which is exactly why it has to be refused
 * rather than returned with a footnote.
 */
@Injectable()
export class SafetyStockPolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
  ) {}

  /**
   * Observed lead times for a variant, from receipts against purchase orders.
   * Measured rather than configured: a vendor's promised lead time is a
   * marketing number, and the gap between it and the observed one is the whole
   * reason safety stock exists.
   */
  async observedLeadTimeDays(orgId: string, productVariantId: number): Promise<number[]> {
    const rows = await this.db.execute<{ days: string }>(sql`
      SELECT EXTRACT(EPOCH FROM (g.received_date::timestamp - po.order_date::timestamp)) / 86400
             AS days
      FROM inv_grn_lines gl
      JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
      JOIN inv_po_lines pol ON pol.org_id = gl.org_id AND pol.id = gl.po_line_id
      JOIN inv_purchase_orders po ON po.org_id = pol.org_id AND po.id = pol.po_id
      WHERE gl.org_id = ${orgId}
        AND pol.product_variant_id = ${productVariantId}
        AND g.received_date >= po.order_date
      ORDER BY g.received_date DESC
      LIMIT 50
    `);
    return rows.map((r) => Number(r.days)).filter((d) => Number.isFinite(d) && d >= 0);
  }

  async policyFor(
    orgId: string,
    productVariantId: number,
    options: { serviceLevel?: number; weeks?: number; fallbackLeadTimeDays?: number } = {},
  ): Promise<SafetyStockPolicyResult> {
    const serviceLevel = options.serviceLevel ?? 0.95;
    const history = await this.baselines.history(orgId, productVariantId, {
      weeks: options.weeks ?? 52,
    });
    const series = history.map((p) => p.quantity);
    const classification = classifyDemand(series);
    const demand = summarise(series);

    const leadTimeDays = await this.observedLeadTimeDays(orgId, productVariantId);
    const notes: string[] = [];

    // Weekly periods throughout, because that is the grain the demand series
    // uses. Mixing daily lead times into weekly demand is a factor-of-seven
    // error that looks entirely plausible.
    let leadTimePeriods: number;
    let leadTimeStdDev: number;
    if (leadTimeDays.length >= 3) {
      const lt = summarise(leadTimeDays.map((d) => d / 7));
      leadTimePeriods = lt.mean;
      leadTimeStdDev = lt.stdDev;
    } else {
      leadTimePeriods = (options.fallbackLeadTimeDays ?? 14) / 7;
      leadTimeStdDev = 0;
      notes.push(
        `Only ${leadTimeDays.length} receipt(s) on record, which cannot support a lead-time deviation. Using a configured lead time and treating it as reliable — the resulting buffer is optimistic.`,
      );
    }

    const applicable =
      classification.category === "smooth" || classification.category === "erratic";

    if (!applicable) {
      notes.push(
        classification.category === "no_demand"
          ? "No demand recorded, so there is nothing to buffer against."
          : `Demand is ${classification.category}. A normal-distribution safety stock does not describe it, and the number it produces would look like a service level without being one. ${classification.guidance}`,
      );
      return {
        productVariantId,
        serviceLevel,
        demandCategory: classification.category,
        demand: { ...demand, periods: series.length },
        leadTime: {
          periods: Number(leadTimePeriods.toFixed(4)),
          stdDev: Number(leadTimeStdDev.toFixed(4)),
          observations: leadTimeDays.length,
        },
        policy: null,
        applicable: false,
        notes,
      };
    }

    const policy = safetyStock({
      demandMean: demand.mean,
      demandStdDev: demand.stdDev,
      leadTimePeriods,
      leadTimeStdDev,
      serviceLevel,
    });

    return {
      productVariantId,
      serviceLevel,
      demandCategory: classification.category,
      demand: { ...demand, periods: series.length },
      leadTime: {
        periods: Number(leadTimePeriods.toFixed(4)),
        stdDev: Number(leadTimeStdDev.toFixed(4)),
        observations: leadTimeDays.length,
      },
      policy,
      applicable: true,
      notes: [...notes, ...policy.warnings],
    };
  }
}
