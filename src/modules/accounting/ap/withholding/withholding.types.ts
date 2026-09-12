/**
 * Withholding tax — the contract (PRD 03 S3, PRD 10 S3).
 *
 * Withholding is a **sibling** of VAT/GST determination, never a mixin on it.
 * They answer different questions on different bases at different moments: the
 * VAT engine asks "what tax does this supply attract?" at document time, the
 * withholding engine asks "how much of what I owe must I keep back and remit on
 * the payee's behalf?" at payment time. India runs both at once (GST on the
 * bill, TDS on the payment) and they share no inputs — folding one into the
 * other would put a payment-time threshold inside a document-time engine.
 *
 * Like the tax engine, `determine` is **pure**: context in, verdict out. It
 * reads no database and writes no journal. Rates live in dated config rows
 * (`withholding.rates.ts`), never as constants in application logic.
 */

/**
 * What the payee is. India's rate for a contractor depends on it (individual
 * and HUF pay a lower rate than a company); most generic regimes ignore it.
 */
export type WithholdingPayeeType = "company" | "individual" | "huf" | "firm" | "other";

export interface WithholdingContext {
  /** Drives which dated rate row is in force. Never `now()`. */
  paymentDate: string;
  currency: string;
  /** What the payee is owed before withholding, in minor units. */
  baseMinor: number;
  /**
   * The section/code the vendor is coded to on the party master —
   * `194J`, `194C`, or a `paymentCode` under the Income Tax Act 2025.
   */
  withholdingCode?: string | null;
  payeeType?: WithholdingPayeeType;
  /** PAN/tax id furnished. Its absence attracts a penal rate in most regimes. */
  taxIdOnFile?: boolean;
  /** Paid to this payee under the same code so far this year, for thresholds. */
  cumulativeBaseMinor?: number;
  /** A lower- or nil-deduction certificate. Wins over the table. */
  overrideRateBp?: number | null;
  overrideReason?: string | null;
}

export interface WithholdingResult {
  regime: string;
  /** False when the code is unknown, the rate is nil, or a threshold is unmet. */
  applicable: boolean;
  /** India practice still speaks in `194J`; kept alongside `paymentCode`. */
  legacySection: string | null;
  /** The Income Tax Act 2025 §393 payment code, or a generic code elsewhere. */
  paymentCode: string | null;
  rateBp: number;
  baseMinor: number;
  withheldMinor: number;
  /** Why this rate, or why nothing — shown to the user, kept for the audit. */
  reason: string;
}

export interface WithholdingCodeSummary {
  legacySection: string;
  paymentCode: string;
  label: string;
  rateBp: number;
}

export interface WithholdingEngine {
  /** Registry key: `INDIA_TDS`, `GENERIC_WHT`. */
  readonly regime: string;
  readonly status: "enabled" | "stub";
  /** Codes this regime offers on a given date, for a settings screen. */
  codes(onDate: string): WithholdingCodeSummary[];
  /** Pure. Never throws for a business problem — an unknown code comes back
   * as `applicable: false` with a reason a founder can act on. */
  determine(context: WithholdingContext): WithholdingResult;
}

export function notApplicable(regime: string, baseMinor: number, reason: string): WithholdingResult {
  return {
    regime,
    applicable: false,
    legacySection: null,
    paymentCode: null,
    rateBp: 0,
    baseMinor,
    withheldMinor: 0,
    reason,
  };
}
