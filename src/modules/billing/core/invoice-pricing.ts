import {
  applyRateBps,
  extractRateBps,
  multiplyMinor,
  sumMinor,
  type RoundingRule,
} from "./money-rounding";

export const TAX_BEHAVIORS = ["INCLUSIVE", "EXCLUSIVE"] as const;

export type TaxBehavior = (typeof TAX_BEHAVIORS)[number];

export interface InvoiceLineInput {
  lineType: string;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxRateBps?: number;
  prorationLineId?: number | null;
  usageRollupId?: number | null;
}

export interface PricedLine {
  subtotalMinor: number;
  taxAmountMinor: number;
  totalMinor: number;
}

export interface PricedDocument {
  lines: PricedLine[];
  subtotalMinor: number;
  taxAmountMinor: number;
  totalMinor: number;
}

/** `INCLUSIVE` means the unit amount already contains the tax, so it is extracted rather than added. */
function priceLine(
  line: InvoiceLineInput,
  roundingRule: RoundingRule,
  taxBehavior: TaxBehavior,
): PricedLine {
  const rateBps = line.taxRateBps ?? 0;
  const lineAmountMinor = multiplyMinor(
    line.unitAmountMinor,
    line.quantity,
    "Line amount",
  );

  if (taxBehavior === "INCLUSIVE") {
    const taxAmountMinor = extractRateBps(lineAmountMinor, rateBps, roundingRule);
    return {
      subtotalMinor: lineAmountMinor - taxAmountMinor,
      taxAmountMinor,
      totalMinor: lineAmountMinor,
    };
  }

  const taxAmountMinor = applyRateBps(lineAmountMinor, rateBps, roundingRule);
  return {
    subtotalMinor: lineAmountMinor,
    taxAmountMinor,
    totalMinor: lineAmountMinor + taxAmountMinor,
  };
}

/** Document totals are the sum of priced lines, never a separately rounded figure, so the two can never disagree. */
export function priceDocument(
  lines: InvoiceLineInput[],
  roundingRule: RoundingRule,
  taxBehavior: TaxBehavior,
): PricedDocument {
  const priced = lines.map((line) => priceLine(line, roundingRule, taxBehavior));
  return {
    lines: priced,
    subtotalMinor: sumMinor(
      priced.map((line) => line.subtotalMinor),
      "Document subtotal",
    ),
    taxAmountMinor: sumMinor(
      priced.map((line) => line.taxAmountMinor),
      "Document tax",
    ),
    totalMinor: sumMinor(
      priced.map((line) => line.totalMinor),
      "Document total",
    ),
  };
}
