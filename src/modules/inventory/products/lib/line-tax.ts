import { BadRequestException } from "@nestjs/common";
import { cmpDec, divDec, mulDec } from "../../stock-engine/decimal";
import type { InvGstMode, InvTaxTreatment } from "../../stock-engine/stock-engine.types";

/**
 * E2 — the tax rule, with no database in it.
 *
 * Everything that decides what a document line records is here: whether the
 * organisation runs the `gst` pack, how it is registered, how the SKU is
 * classified, and what the caller asked for. The service around it does the two
 * reads and hands the answers in. Kept separate because this is the part that
 * has to be exercised exhaustively — five treatments times two document kinds
 * times two registrations — and none of those cases needs a row in a table.
 */

/** What a document line records. `null` means "not recorded", never "nil". */
export interface LineTaxSnapshot {
  hsnCode: string | null;
  taxTreatment: InvTaxTreatment | null;
  gstMode: InvGstMode | null;
  /** Percent, scale 2 — "18.00", not "0.18". */
  taxRate: string;
  /** Exact, scale 4. */
  taxAmount: string;
}

export type TaxDocumentKind = "PURCHASE" | "SALE";

/** The SKU's classification. `null` means the pack is off and none was read. */
export interface ProductTaxClassification {
  hsnCode: string | null;
  taxTreatment: InvTaxTreatment | null;
  gstRate: string | null;
}

export interface ResolveTaxSnapshotInput {
  /** `null` when the `gst` pack is off — there is nothing to classify by. */
  classification: ProductTaxClassification | null;
  gstMode: InvGstMode;
  documentKind: TaxDocumentKind;
  /** The line's tax-exclusive taxable value: entered quantity × unit price. */
  taxableAmount: string;
  /**
   * What the caller asked for, if anything. Absent means "take the SKU's
   * default". Present and disagreeing with the classification is refused rather
   * than silently corrected: a document that quietly charges a different rate
   * from the one that was typed is worse than one that will not save.
   */
  requestedRate?: string;
}

const ZERO_RATE = "0.00";
const ZERO_AMOUNT = "0.0000";

/**
 * The one rounding rule, stated once.
 *
 * `rate / 100` is exact: a percent at scale 2 divided by 100 lands at scale 4,
 * which these helpers represent without loss. So the only rounding in the whole
 * calculation is the single multiplication — **half-up at the fourth decimal**,
 * the scale every money column in this module carries.
 *
 * Rounding once is the point. `mulDec(amount, rate)` followed by
 * `divDec(…, "100")` rounds twice and can disagree with this, which is invisible
 * on one line and not on a ten-thousand-line return.
 *
 * Inventory deliberately does not round to the currency's minor unit here. It
 * does not raise the invoice; rounding to two decimals is the last step before a
 * document is issued, and doing it early makes every downstream total the sum of
 * pre-rounded parts.
 */
export function computeLineTax(taxableAmount: string, taxRatePercent: string): string {
  return mulDec(taxableAmount, divDec(taxRatePercent, "100"));
}

function isZeroRate(rate: string): boolean {
  return cmpDec(rate, "0") === 0;
}

export function resolveTaxSnapshot(input: ResolveTaxSnapshotInput): LineTaxSnapshot {
  const { classification, gstMode, documentKind, taxableAmount, requestedRate } = input;

  // Pack off: no classification exists, so nothing is recorded. The rate the
  // caller supplied is still honoured and still computed exactly — that is what
  // purchase and sales orders did before E2, and turning the pack on is what
  // makes classification exist, not a second way of writing "rate zero".
  if (!classification) {
    const rate = requestedRate ?? ZERO_RATE;
    return {
      hsnCode: null,
      taxTreatment: null,
      gstMode: null,
      taxRate: rate,
      taxAmount: computeLineTax(taxableAmount, rate),
    };
  }

  const treatment: InvTaxTreatment = classification.taxTreatment ?? "TAXABLE";

  // Checked before the treatment: a composition dealer's outward document cannot
  // show a split whatever the goods are, and refusing with "exempt goods cannot
  // be taxed" would send the operator to the wrong screen to fix it.
  if (documentKind === "SALE" && gstMode === "COMPOSITION") {
    if (requestedRate !== undefined && !isZeroRate(requestedRate)) {
      throw new BadRequestException({
        code: "COMPOSITION_NO_OUTWARD_TAX",
        message:
          "This organisation is registered under the GST composition scheme and cannot charge tax on a sale. Remove the tax rate from this line.",
      });
    }
    return {
      hsnCode: classification.hsnCode,
      taxTreatment: treatment,
      gstMode,
      taxRate: ZERO_RATE,
      taxAmount: ZERO_AMOUNT,
    };
  }

  if (treatment !== "TAXABLE") {
    if (requestedRate !== undefined && !isZeroRate(requestedRate)) {
      throw new BadRequestException({
        code: "TAX_TREATMENT_NOT_TAXABLE",
        message: `This product is classified ${treatment} and cannot carry a tax rate. Change its tax treatment to TAXABLE or remove the rate from this line.`,
      });
    }
    return {
      hsnCode: classification.hsnCode,
      taxTreatment: treatment,
      gstMode,
      taxRate: ZERO_RATE,
      taxAmount: ZERO_AMOUNT,
    };
  }

  const rate = requestedRate ?? classification.gstRate ?? ZERO_RATE;
  return {
    hsnCode: classification.hsnCode,
    taxTreatment: treatment,
    gstMode,
    taxRate: rate,
    taxAmount: computeLineTax(taxableAmount, rate),
  };
}
