import { Injectable } from "@nestjs/common";
import { DemandBaselineService } from "./demand-baseline.service";
import { classifyDemand, type DemandCategory } from "./demand-shape";
import { LeadTimeService } from "./lead-time.service";
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
    private readonly baselines: DemandBaselineService,
    private readonly leadTimes: LeadTimeService,
  ) {}

  /**
   * Observed lead times for a variant, from receipts against purchase orders.
   * Measured rather than configured: a vendor's promised lead time is a
   * marketing number, and the gap between it and the observed one is the whole
   * reason safety stock exists.
   *
   * C4 moved the derivation into `LeadTimeService`, which is where the same
   * observation is defined for the vendor scorecard. A second copy here drifted
   * the moment one of them learned to ignore an abandoned receipt.
   */
  observedLeadTimeDays(orgId: string, productVariantId: number): Promise<number[]> {
    return this.leadTimes.variantLeadTimeDays(orgId, productVariantId);
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
