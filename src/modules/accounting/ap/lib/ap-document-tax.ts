import type { TaxGlRole } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { DetermineResult, TaxService } from "../../tax/tax.service";
import type { TaxContext, TaxContextRegistration } from "../../tax/tax.types";
import type { ApTaxPreview } from "../ap.types";
import type { ApVendor } from "../ap.vendor-lookup";
import { computeLineNet, type DocumentRow, type LineRow } from "./ap-document-rows";

/** Tax roles that debit an asset (or, when blocked, an expense). */
export const INPUT_ROLES = new Set<TaxGlRole>(["input_recoverable", "reverse_charge_input"]);
/** Tax roles that credit a liability — including the reverse-charge output leg. */
export const OUTPUT_ROLES = new Set<TaxGlRole>(["output_payable", "reverse_charge_output"]);

export interface ComputedTotals {
  determination: DetermineResult;
  netMinor: number;
  /** What the vendor charged — input tax net of any reverse-charge offset. */
  taxMinor: number;
  /** The reverse-charge leg the buyer accounts for on both sides. */
  selfAssessedTaxMinor: number;
  /** Input tax the engine marked non-recoverable, which is costed not capitalised. */
  blockedTaxMinor: number;
  roundingMinor: number;
  grossMinor: number;
  perLine: Map<string, { netMinor: number; taxMinor: number; grossMinor: number }>;
}

/**
 * Run determination and roll the answer up into document totals.
 *
 * The interesting arithmetic is what accounts payable should carry. A vendor
 * charges input tax and is owed it; under reverse charge the engine also
 * returns an output leg, and the two cancel — so `taxMinor` is input less
 * output, which is exactly the tax on the vendor's own document. The
 * self-assessed leg moves GST without moving money and is reported apart.
 */
export async function computeTotals(
  tax: TaxService,
  reader: DbOrTx,
  doc: DocumentRow,
  lines: LineRow[],
  vendor: ApVendor,
  bookCountryCode: string,
  tx: DbOrTx = reader,
): Promise<ComputedTotals> {
  const context = await buildTaxContext(tax, reader, doc, lines, vendor, bookCountryCode);
  const determination = await tax.determine(doc.bookId, context, tx);

  const byLine = new Map(determination.lines.map((l) => [l.documentLineId, l]));
  const perLine = new Map<string, { netMinor: number; taxMinor: number; grossMinor: number }>();

  let netMinor = 0;
  let taxMinor = 0;
  let selfAssessedTaxMinor = 0;
  let blockedTaxMinor = 0;

  for (const line of lines) {
    const resolved = byLine.get(line.id);
    // No verdict for a line means determination failed on it; the caller
    // surfaces `errors` rather than posting a document with a hole in it.
    const lineNet = resolved?.taxableMinor ?? computeLineNet(line);
    let lineTax = 0;

    for (const component of resolved?.components ?? []) {
      if (INPUT_ROLES.has(component.glRole)) {
        lineTax += component.taxMinor;
        if (!component.recoverable) blockedTaxMinor += component.taxMinor;
      } else if (OUTPUT_ROLES.has(component.glRole)) {
        lineTax -= component.taxMinor;
        selfAssessedTaxMinor += component.taxMinor;
      }
    }

    netMinor += lineNet;
    taxMinor += lineTax;
    perLine.set(line.id, {
      netMinor: lineNet,
      taxMinor: lineTax,
      grossMinor: lineNet + lineTax,
    });
  }

  const roundingMinor = determination.roundingAdjustmentMinor;
  return {
    determination,
    netMinor,
    taxMinor,
    selfAssessedTaxMinor,
    blockedTaxMinor,
    roundingMinor,
    grossMinor: netMinor + taxMinor + roundingMinor,
    perLine,
  };
}

/**
 * The purchase context.
 *
 * On a purchase the **vendor** is the supplier, so its registrations are the
 * "seller" ones the engine reasons from and the book's are the buyer's — the
 * exact inverse of a sales invoice. A vendor with nothing on file still has a
 * place of supply, so the document's from-location stands in under the book's
 * own regime; a supplier genuinely outside the tax net is modelled by the
 * document's `supplyNature`, which the engine already understands.
 */
async function buildTaxContext(
  tax: TaxService,
  reader: DbOrTx,
  doc: DocumentRow,
  lines: LineRow[],
  vendor: ApVendor,
  bookCountryCode: string,
): Promise<TaxContext> {
  const bookRegistrations = await tax.loadRegistrations("book", doc.bookId, reader);
  const vendorRegistrations = await tax.loadRegistrations("party", vendor.id, reader);

  const fromCountry =
    doc.taxLocationFromCountry ?? vendor.billingCountryCode ?? vendor.countryCode;
  const fromRegion = doc.taxLocationFromRegion ?? vendor.billingRegion ?? null;
  const toCountry = doc.taxLocationToCountry ?? bookCountryCode;
  const toRegion =
    doc.taxLocationToRegion ??
    doc.placeOfSupplyCode ??
    bookRegistrations.find((r) => r.region)?.region ??
    null;

  const sellerRegistrations: TaxContextRegistration[] =
    vendorRegistrations.length > 0
      ? vendorRegistrations
      : bookRegistrations.map((r) => ({
          regime: r.regime,
          number: "",
          region: fromRegion,
          countryCode: fromCountry,
        }));

  return {
    bookId: doc.bookId,
    direction: "purchase",
    documentDate: doc.issueDate,
    currency: doc.currency,
    supplyNature: doc.supplyNature,
    from: { countryCode: fromCountry, region: fromRegion },
    to: { countryCode: toCountry, region: toRegion },
    sellerRegistrations,
    buyerRegistrations: bookRegistrations,
    taxInclusive: doc.taxInclusive,
    flags: { blockedInput: doc.blockedInputTax },
    lines: lines.map((line) => ({
      id: line.id,
      taxableMinor: computeLineNet(line),
      taxCategory: line.taxCategory,
      commodityCode: line.commodityCode,
      forceTaxCodeId: line.forcedTaxCodeId,
      quantity: line.quantityMilli / 1000,
      uom: line.unit,
    })),
  };
}

/**
 * The frozen tax lines must name the account the journal actually used, or a
 * blocked-input reconciliation would point at an asset nobody debited.
 * `TaxService` resolves the map by role alone, so re-point the blocked ones.
 */
export function withResolvedTaxAccounts(
  determination: DetermineResult,
  blockedFallbackId: string,
): DetermineResult {
  const resolved = new Map(determination.accountByRoleAndComponent);
  for (const line of determination.lines) {
    for (const component of line.components) {
      if (INPUT_ROLES.has(component.glRole) && !component.recoverable) {
        resolved.set(
          `${component.glRole}:${component.code}`,
          determination.accountByRoleAndComponent.get(`blocked_input:${component.code}`) ??
            blockedFallbackId,
        );
      }
    }
  }
  return { ...determination, accountByRoleAndComponent: resolved };
}

/** The totals as `previewTax` reports them, each component with its account. */
export function toTaxPreview(
  documentId: string,
  currency: string,
  totals: ComputedTotals,
): ApTaxPreview {
  return {
    documentId,
    currency,
    netMinor: totals.netMinor,
    taxMinor: totals.taxMinor,
    selfAssessedTaxMinor: totals.selfAssessedTaxMinor,
    blockedTaxMinor: totals.blockedTaxMinor,
    roundingMinor: totals.roundingMinor,
    grossMinor: totals.grossMinor,
    lines: totals.determination.lines.map((line) => ({
      documentLineId: line.documentLineId,
      taxCode: line.taxCode,
      taxCodeId: line.taxCodeId,
      category: line.category,
      taxableMinor: line.taxableMinor,
      totalTaxMinor: line.totalTaxMinor,
      components: line.components.map((component) => ({
        component: component.code,
        jurisdiction: component.jurisdiction,
        rateBp: component.rateBp,
        taxableMinor: component.taxableMinor,
        taxMinor: component.taxMinor,
        recoverable: component.recoverable,
        glRole: component.glRole,
        glAccountId:
          totals.determination.accountByRoleAndComponent.get(
            `${component.glRole}:${component.code}`,
          ) ?? null,
      })),
    })),
    errors: totals.determination.errors,
    warnings: totals.determination.warnings,
  };
}
