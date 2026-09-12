import { createHash } from "node:crypto";
import type { TaxDetermination } from "./tax-determination";

/**
 * Everything an invoice was computed from, and the invoice it computed to.
 *
 * Phase 3 ticket 05. An invoice must regenerate byte-identically from what was
 * stored, because that is what makes a tax position defensible and an
 * accountant's question answerable eighteen months later. Recomputing against
 * current configuration answers a different question -- it tells you what we
 * would charge today, which is not what was charged.
 *
 * So nothing here is derived at render time. The line amounts, the tax heads,
 * the rate version and the exchange-free currency are all captured at the moment
 * of the charge, and rendering is a pure function of the snapshot.
 */

export interface InvoiceLineSnapshot {
  readonly description: string;
  readonly quantity: number;
  /** Integer minor units, per unit. */
  readonly unitAmountMinor: number;
  readonly amountMinor: number;
}

export interface InvoiceSnapshot {
  readonly invoiceNumber: string;
  /** ISO 8601, captured rather than read from a clock at render time. */
  readonly issuedAt: string;
  readonly currency: string;
  readonly seller: { readonly name: string; readonly country: string; readonly taxId?: string };
  readonly buyer: {
    readonly name: string;
    readonly country: string;
    readonly state?: string | null;
    readonly taxId?: string | null;
    readonly addressLines: readonly string[];
  };
  readonly lines: readonly InvoiceLineSnapshot[];
  readonly tax: TaxDetermination;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

/**
 * The invoice as text, derived only from the snapshot.
 *
 * Deterministic by construction: no clock, no locale lookup, no configuration
 * read. Given the same snapshot it produces the same bytes on any machine on any
 * day, which is the whole claim.
 *
 * Currency is formatted from the minor-unit integer directly rather than through
 * `Intl`, because `Intl` output varies with the ICU version bundled in the
 * runtime -- an invoice rendered on a new Node release would differ from the one
 * the customer received, and the difference would be invisible until somebody
 * compared them.
 */
export function renderInvoice(snapshot: InvoiceSnapshot): string {
  const money = (minor: number): string => {
    const sign = minor < 0 ? "-" : "";
    const abs = Math.abs(minor);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  };

  const lines: string[] = [
    `INVOICE ${snapshot.invoiceNumber}`,
    `Issued: ${snapshot.issuedAt}`,
    `Currency: ${snapshot.currency}`,
    "",
    `From: ${snapshot.seller.name} (${snapshot.seller.country})`,
    ...(snapshot.seller.taxId ? [`      ${snapshot.seller.taxId}`] : []),
    "",
    `To:   ${snapshot.buyer.name} (${snapshot.buyer.country})`,
    ...snapshot.buyer.addressLines.map((line) => `      ${line}`),
    ...(snapshot.buyer.taxId ? [`      ${snapshot.buyer.taxId}`] : []),
    "",
  ];

  for (const line of snapshot.lines)
    lines.push(
      `${line.description} × ${line.quantity} @ ${money(line.unitAmountMinor)} = ${money(line.amountMinor)}`,
    );

  lines.push("", `Net:   ${money(snapshot.netMinor)}`);

  for (const component of snapshot.tax.components)
    lines.push(
      `${component.name} (${(component.rateBasisPoints / 100).toFixed(2)}%): ${money(component.amountMinor)}`,
    );

  lines.push(
    `Tax:   ${money(snapshot.taxMinor)}`,
    `Total: ${money(snapshot.grossMinor)}`,
    "",
    snapshot.tax.reason,
    `Rates version: ${snapshot.tax.inputs.ratesVersion}`,
  );

  return lines.join("\n");
}

/**
 * A fingerprint of the rendered invoice.
 *
 * Stored alongside the snapshot so a later render can be *proved* identical
 * rather than assumed. Comparing hashes is how a silent divergence -- a changed
 * formatter, a new runtime -- is caught the first time it happens rather than
 * during a dispute.
 */
export function invoiceFingerprint(snapshot: InvoiceSnapshot): string {
  return createHash("sha256").update(renderInvoice(snapshot), "utf8").digest("hex");
}

/** Whether an invoice still renders to what it rendered to when it was issued. */
export function reproduces(snapshot: InvoiceSnapshot, storedFingerprint: string): boolean {
  return invoiceFingerprint(snapshot) === storedFingerprint;
}

/**
 * Checks the snapshot's own arithmetic before it is stored.
 *
 * A snapshot whose totals do not agree with its lines is worse than no snapshot:
 * it reproduces perfectly and reproduces something wrong.
 */
export function snapshotProblems(snapshot: InvoiceSnapshot): string[] {
  const problems: string[] = [];

  const lineTotal = snapshot.lines.reduce((total, line) => total + line.amountMinor, 0);
  if (lineTotal !== snapshot.netMinor)
    problems.push(`lines total ${lineTotal} but net is ${snapshot.netMinor}`);

  const taxTotal = snapshot.tax.components.reduce((total, c) => total + c.amountMinor, 0);
  if (taxTotal !== snapshot.taxMinor)
    problems.push(`tax heads total ${taxTotal} but tax is ${snapshot.taxMinor}`);

  if (snapshot.netMinor + snapshot.taxMinor !== snapshot.grossMinor)
    problems.push(`net plus tax is not gross`);

  if (snapshot.tax.netMinor !== snapshot.netMinor)
    problems.push(`the tax determination was made against a different net`);

  for (const line of snapshot.lines)
    if (line.unitAmountMinor * line.quantity !== line.amountMinor)
      problems.push(`line "${line.description}" does not multiply out`);

  if (!Number.isInteger(snapshot.netMinor) || !Number.isInteger(snapshot.grossMinor))
    problems.push("amounts must be integer minor units");

  return problems;
}
