import { BadRequestException } from "@nestjs/common";
import { round2 } from "./invoice-helpers";

/**
 * Re-deriving an invoice's tax when its lines are replaced.
 *
 * An invoice records the same fact three times: `invoice_items.gst_rate` per
 * line, `invoices.tax_amount` as the pool, and `cgst/sgst/igst_amount` as the
 * split. They must be written together or they disagree, and a disagreement is
 * not cosmetic — `postInvoiceSend` debits receivables by `total` and credits
 * revenue plus the split, so a stale split makes the journal refuse to balance
 * and the invoice can never be issued.
 *
 * MONEY UNITS. `amount`, `subtotal`, `discount`, `taxPool` and `total` are all
 * RUPEES (the unit of the numeric(18,4) columns and of the write DTO).
 * `gstRate` and `blendedRate` are PERCENTAGES.
 */

/** The tax-bearing columns of a persisted `invoice_items` row. */
export interface StoredLineTax {
  gstRate: string;
  hsnSacCode: string | null;
}

/** A line as the edit DTO sends it: `gstRate`/`hsnSacCode` may be absent. */
export interface RequestedLine {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  gstRate?: number;
  hsnSacCode?: string;
}

/** A line with its tax basis settled, ready to be written. */
export interface ResolvedLine {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  gstRate: number;
  hsnSacCode: string | null;
}

export interface InvoiceTotals {
  subtotal: number;
  taxRate: number;
  taxPool: number;
  discount: number;
  total: number;
}

function carriedRate(row: StoredLineTax | undefined): number | undefined {
  if (!row) return undefined;
  const parsed = Number(row.gstRate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Settles each replacement line's GST rate and HSN/SAC code.
 *
 * A caller that sends them is believed. A caller that does not — the shipped
 * edit dialog before this change, and anything hitting `PATCH /invoices/{id}`
 * with the bare legacy shape — has its stored values carried forward by
 * position, which is exact for the only two edits that keep positions
 * meaningful: changing a line in place, and appending to the end.
 *
 * A SHORTER list means a line was removed, and then request position i is no
 * longer storage position i. Carrying the rate over there would tax the
 * survivor at the deleted line's rate, so if anything stored is taxed the edit
 * is refused instead. The previous behaviour — writing gst_rate "0.00" and
 * hsn_sac_code NULL over every line — is what this replaces.
 */
export function resolveLineItems(
  requested: ReadonlyArray<RequestedLine>,
  stored: ReadonlyArray<StoredLineTax>,
): ResolvedLine[] {
  const positionsHold = requested.length >= stored.length;
  const storedIsTaxed = stored.some((row) => (carriedRate(row) ?? 0) > 0);

  return requested.map((line, index) => {
    const carried = positionsHold ? stored[index] : undefined;
    const gstRate = line.gstRate ?? carriedRate(carried);
    if (gstRate === undefined && storedIsTaxed) {
      throw new BadRequestException(
        "Removing a line from a GST invoice would misattribute the remaining lines' tax. Send gstRate on every line item.",
      );
    }
    return {
      description: line.description,
      quantity: line.quantity,
      rate: line.rate,
      amount: round2(line.amount),
      gstRate: gstRate ?? 0,
      hsnSacCode: line.hsnSacCode ?? carried?.hsnSacCode ?? null,
    };
  });
}

/**
 * The invoice's money, recomputed from the settled lines.
 *
 * Per-line GST is the tax basis whenever any line carries a rate — that is what
 * the create path writes, and it is why create always stores `tax_rate` "0".
 * The blended `tax_rate` percentage is honoured only for an invoice whose lines
 * carry no rate at all, which is the shape the legacy model produced; that keeps
 * those invoices editable without letting a blended 0 from the edit dialog erase
 * a per-line pool.
 */
export function computeInvoiceTotals(
  lines: ReadonlyArray<ResolvedLine>,
  blendedRate: number,
  discountInput: number,
): InvoiceTotals {
  // Rupees.
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const perLinePool = round2(
    lines.reduce((sum, line) => sum + round2(line.amount * (line.gstRate / 100)), 0),
  );
  const anyPerLineGst = lines.some((line) => line.gstRate > 0);
  const usesBlended = !anyPerLineGst && blendedRate > 0;

  const taxPool = usesBlended ? round2(subtotal * (blendedRate / 100)) : perLinePool;
  const discount = round2(discountInput);
  return {
    subtotal,
    taxRate: usesBlended ? blendedRate : 0,
    taxPool,
    discount,
    total: round2(subtotal + taxPool - discount),
  };
}
