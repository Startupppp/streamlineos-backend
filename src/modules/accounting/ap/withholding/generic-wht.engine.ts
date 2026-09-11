import { applyBasisPoints, money } from "../../kernel/money";
import { findRate, GENERIC_WHT_RATES, ratesInForce, type WithholdingRateRow } from "./withholding.rates";
import {
  notApplicable,
  type WithholdingCodeSummary,
  type WithholdingContext,
  type WithholdingEngine,
  type WithholdingResult,
} from "./withholding.types";

/**
 * A flat-rate withholding regime — registry key `GENERIC_WHT`.
 *
 * Deliberately small, the same way `GenericVatEngine` is: it exists so a book
 * outside India can still withhold correctly, and so the engine seam is proven
 * to be a seam rather than India with a coat of paint. No thresholds, no payee
 * classes — a rate row and a base.
 */
export class GenericWhtEngine implements WithholdingEngine {
  readonly regime = "GENERIC_WHT";
  readonly status = "enabled" as const;

  constructor(private readonly rates: readonly WithholdingRateRow[] = GENERIC_WHT_RATES) {}

  codes(onDate: string): WithholdingCodeSummary[] {
    return ratesInForce(this.rates, onDate).map((r) => ({
      legacySection: r.legacySection,
      paymentCode: r.paymentCode,
      label: r.label,
      rateBp: r.rateBp,
    }));
  }

  determine(context: WithholdingContext): WithholdingResult {
    const { baseMinor } = context;

    if (baseMinor <= 0) {
      return notApplicable(this.regime, baseMinor, "Nothing is being paid, so nothing is withheld");
    }
    if (!context.withholdingCode) {
      return notApplicable(
        this.regime,
        baseMinor,
        "This vendor has no withholding code. Set one on the vendor to deduct at source.",
      );
    }

    const row = findRate(this.rates, context.withholdingCode, context.paymentDate);
    if (!row) {
      return notApplicable(
        this.regime,
        baseMinor,
        `No withholding rate is configured for ${context.withholdingCode} on ${context.paymentDate}`,
      );
    }

    const override = context.overrideRateBp;
    const rateBp = override != null ? override : row.rateBp;
    const withheldMinor = applyBasisPoints(money(baseMinor, context.currency), rateBp).minor;

    return {
      regime: this.regime,
      applicable: withheldMinor > 0,
      legacySection: row.legacySection,
      paymentCode: row.paymentCode,
      rateBp,
      baseMinor,
      withheldMinor,
      reason:
        override != null
          ? (context.overrideReason ?? `Certificate rate ${(override / 100).toFixed(2)}% applied`)
          : `${row.label} at ${(rateBp / 100).toFixed(2)}%`,
    };
  }
}
