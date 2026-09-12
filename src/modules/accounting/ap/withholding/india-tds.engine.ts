import { applyBasisPoints, money } from "../../kernel/money";
import { findRate, INDIA_TDS_RATES, ratesInForce, type WithholdingRateRow } from "./withholding.rates";
import {
  notApplicable,
  type WithholdingCodeSummary,
  type WithholdingContext,
  type WithholdingEngine,
  type WithholdingResult,
} from "./withholding.types";

/**
 * India TDS — registry key `INDIA_TDS`.
 *
 * Implements the withholding contract; it does **not** own payments, and
 * `ap-payments.service.ts` never mentions India. Every number it uses comes
 * from `withholding.rates.ts`, which carries the standing "as of 2026-08,
 * illustrative, verify before relying on this" warning — this file holds the
 * *rules* (thresholds, payee class, missing-PAN penalty), not the *rates*.
 *
 * Both identifiers travel with the result: `legacySection` (`194J`) because
 * that is what a vendor master, a challan and an accountant all say, and
 * `paymentCode` because the Income Tax Act 2025 files the same payment under
 * §393. `ap_withholding` stores both so neither has to be reverse-engineered.
 */
export class IndiaTdsEngine implements WithholdingEngine {
  readonly regime = "INDIA_TDS";
  readonly status = "enabled" as const;

  constructor(private readonly rates: readonly WithholdingRateRow[] = INDIA_TDS_RATES) {}

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
        "This vendor has no TDS section on file. Set one on the vendor to deduct at source.",
      );
    }

    const row = findRate(this.rates, context.withholdingCode, context.paymentDate);
    if (!row) {
      return notApplicable(
        this.regime,
        baseMinor,
        `No TDS rate is configured for ${context.withholdingCode} on ${context.paymentDate}`,
      );
    }

    // A lower- or nil-deduction certificate under s197 beats the table outright,
    // including its thresholds — the certificate is the instruction.
    if (context.overrideRateBp != null) {
      return this.result(context, row, context.overrideRateBp, {
        reason:
          context.overrideReason ??
          `Lower-deduction certificate at ${(context.overrideRateBp / 100).toFixed(2)}%`,
      });
    }

    const cumulative = context.cumulativeBaseMinor ?? 0;
    const belowSingle =
      row.singleThresholdMinor != null && baseMinor < row.singleThresholdMinor;
    const belowAnnual =
      row.annualThresholdMinor != null && cumulative + baseMinor < row.annualThresholdMinor;

    // Either limit being crossed brings the payment into charge; only when both
    // are still unmet is nothing deducted.
    if (belowSingle && belowAnnual) {
      return {
        ...notApplicable(
          this.regime,
          baseMinor,
          `Below the ${row.legacySection} thresholds — this payment and the year to date are ` +
            "both under the limit, so nothing is deducted",
        ),
        legacySection: row.legacySection,
        paymentCode: row.paymentCode,
      };
    }

    const rateBp = this.rateFor(row, context);
    const reason = this.reasonFor(row, context, rateBp);
    return this.result(context, row, rateBp, { reason });
  }

  /**
   * Rate selection, in priority order: a missing tax id attracts the penal rate
   * regardless of payee class, then the individual/HUF rate where the row draws
   * that distinction, then the row's default.
   */
  private rateFor(row: WithholdingRateRow, context: WithholdingContext): number {
    if (context.taxIdOnFile === false && row.noTaxIdRateBp != null) return row.noTaxIdRateBp;
    const isIndividual = context.payeeType === "individual" || context.payeeType === "huf";
    if (isIndividual && row.individualRateBp != null) return row.individualRateBp;
    return row.rateBp;
  }

  private reasonFor(
    row: WithholdingRateRow,
    context: WithholdingContext,
    rateBp: number,
  ): string {
    if (context.taxIdOnFile === false && row.noTaxIdRateBp === rateBp) {
      return `${row.legacySection} at the higher ${(rateBp / 100).toFixed(2)}% — no PAN on file`;
    }
    if (row.individualRateBp === rateBp && rateBp !== row.rateBp) {
      return `${row.label} at ${(rateBp / 100).toFixed(2)}% (individual or HUF payee)`;
    }
    return `${row.label} at ${(rateBp / 100).toFixed(2)}%`;
  }

  private result(
    context: WithholdingContext,
    row: WithholdingRateRow,
    rateBp: number,
    extra: { reason: string },
  ): WithholdingResult {
    const withheldMinor = applyBasisPoints(money(context.baseMinor, context.currency), rateBp).minor;
    return {
      regime: this.regime,
      applicable: withheldMinor > 0,
      legacySection: row.legacySection,
      paymentCode: row.paymentCode,
      rateBp,
      baseMinor: context.baseMinor,
      withheldMinor,
      reason: extra.reason,
    };
  }
}
