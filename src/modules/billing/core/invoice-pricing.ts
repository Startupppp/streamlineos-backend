import { applyRateBps, multiplyMinor, sumMinor, type RoundingRule } from "./money-rounding";

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

function priceLine(line: InvoiceLineInput, roundingRule: RoundingRule): PricedLine {
  const subtotalMinor = multiplyMinor(line.unitAmountMinor, line.quantity, "Line subtotal");
  const taxAmountMinor = applyRateBps(subtotalMinor, line.taxRateBps ?? 0, roundingRule);
  return { subtotalMinor, taxAmountMinor, totalMinor: subtotalMinor + taxAmountMinor };
}

/** Document totals are the sum of priced lines, never a separately rounded figure, so the two can never disagree. */
export function priceDocument(lines: InvoiceLineInput[], roundingRule: RoundingRule): PricedDocument {
  const priced = lines.map((line) => priceLine(line, roundingRule));
  return {
    lines: priced,
    subtotalMinor: sumMinor(priced.map((line) => line.subtotalMinor), "Document subtotal"),
    taxAmountMinor: sumMinor(priced.map((line) => line.taxAmountMinor), "Document tax"),
    totalMinor: sumMinor(priced.map((line) => line.totalMinor), "Document total"),
  };
}
