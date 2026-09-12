import { Injectable } from "@nestjs/common";
import { DemandBaselineService, demandSeries, type DemandScope } from "./demand-baseline.service";
import { classifyDemand, type DemandCategory } from "./demand-shape";
import { LeadTimeService } from "./lead-time.service";
import { describe as summarise, safetyStock, type SafetyStockResult } from "./safety-stock";

export interface SafetyStockPolicyResult {
  productVariantId: number;
  /** Null when the policy covers the whole organisation. */
  warehouseId: number | null;
  serviceLevel: number;
  demandCategory: DemandCategory;
  demand: { mean: number; stdDev: number; periods: number };
  leadTime: { periods: number; stdDev: number; observations: number };
  /** Null when the model does not apply to this demand shape. */
  policy: SafetyStockResult | null;
  applicable: boolean;
  /**
   * Why the model was declined, when it was. Set exactly when `applicable` is
   * false — the refusal is a value the caller can store, not a note it has to
   * fish out of the end of `notes` and hope stays last.
   */
  refusalReason: string | null;
  /** C1. Set when demand was measured over periods with nothing on the shelf. */
  stockoutCensored: boolean;
  censoredPeriods: number;
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
 *
 * Note on number types (C1, and see `exact.ts`): everything on this path is
 * statistical — a mean, a sample deviation, a z-score, √(L·σ_d² + d̄²·σ_L²) —
 * and stays in floating point deliberately. The exact quantities are the demand
 * history it reads, which arrives as decimal strings, and the safety stock and
 * reorder point it produces, which become exact again the moment they are
 * stored or compared against a stock position.
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
   * the moment one of them learned to ignore an abandoned receipt. C1 passes a
   * warehouse through to it for the same reason — still one definition, now with
   * a filter on it.
   */
  observedLeadTimeDays(
    orgId: string,
    productVariantId: number,
    warehouseId: number | null = null,
  ): Promise<number[]> {
    return this.leadTimes.variantLeadTimeDays(orgId, productVariantId, warehouseId);
  }

  async policyFor(
    orgId: string,
    productVariantId: number,
    options: {
      serviceLevel?: number;
      weeks?: number;
      fallbackLeadTimeDays?: number;
    } & DemandScope = {},
  ): Promise<SafetyStockPolicyResult> {
    const serviceLevel = options.serviceLevel ?? 0.95;
    const warehouseId = options.warehouseId ?? null;
    const history = await this.baselines.history(orgId, productVariantId, {
      weeks: options.weeks ?? 52,
      warehouseId,
    });
    const series = demandSeries(history);
    const classification = classifyDemand(series);
    const demand = summarise(series);

    const leadTimeDays = await this.observedLeadTimeDays(orgId, productVariantId, warehouseId);
    const notes: string[] = [];

    const censoredPeriods = history.filter((p) => p.stockoutCensored).length;
    if (censoredPeriods > 0) {
      // Stated before the model's own warnings, because it undercuts the input
      // rather than the method: a buffer sized from censored demand is too small
      // in exactly the periods it was meant to cover.
      notes.push(
        `${censoredPeriods} of ${history.length} periods closed with nothing on hand, so measured demand is a lower bound and this buffer is correspondingly optimistic.`,
      );
    }

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

    const shared = {
      productVariantId,
      warehouseId,
      serviceLevel,
      demandCategory: classification.category,
      demand: { ...demand, periods: series.length },
      leadTime: {
        periods: Number(leadTimePeriods.toFixed(4)),
        stdDev: Number(leadTimeStdDev.toFixed(4)),
        observations: leadTimeDays.length,
      },
      stockoutCensored: censoredPeriods > 0,
      censoredPeriods,
    };

    if (!applicable) {
      const refusalReason =
        classification.category === "no_demand"
          ? "No demand recorded, so there is nothing to buffer against."
          : `Demand is ${classification.category}. A normal-distribution safety stock does not describe it, and the number it produces would look like a service level without being one. ${classification.guidance}`;
      notes.push(refusalReason);
      return { ...shared, policy: null, applicable: false, refusalReason, notes };
    }

    const policy = safetyStock({
      demandMean: demand.mean,
      demandStdDev: demand.stdDev,
      leadTimePeriods,
      leadTimeStdDev,
      serviceLevel,
    });

    return {
      ...shared,
      policy,
      applicable: true,
      refusalReason: null,
      notes: [...notes, ...policy.warnings],
    };
  }
}
