/**
 * AR documents and the tax engine: the context a determination runs on, and
 * the preview the invoice screen shows without writing anything.
 */
import type { DbOrTx } from "../../kernel/sequence.service";
import type { PartyDetail } from "../../parties/parties.service";
import type { DetermineResult, TaxService } from "../../tax/tax.service";
import type { TaxContext } from "../../tax/tax.types";
import type { ArDocumentHeader, ComputedLine, TaxPreview } from "../ar-documents.types";

export async function buildTaxContext(
  tax: TaxService,
  header: ArDocumentHeader,
  party: PartyDetail,
  lines: ComputedLine[],
  tx: DbOrTx,
): Promise<TaxContext> {
  const [sellerRegistrations, buyerRegistrations] = await Promise.all([
    tax.loadRegistrations("book", header.bookId, tx),
    tax.loadRegistrations("party", header.partyId, tx),
  ]);

  return {
    bookId: header.bookId,
    direction: "sale",
    documentDate: header.issueDate,
    currency: header.currency,
    supplyNature: header.supplyNature,
    from: {
      countryCode: header.taxLocationFromCountry ?? "",
      region: header.taxLocationFromRegion,
    },
    to: {
      countryCode:
        header.taxLocationToCountry ?? party.billingCountryCode ?? party.countryCode,
      region: header.placeOfSupplyCode ?? header.taxLocationToRegion ?? party.billingRegion,
    },
    sellerRegistrations,
    buyerRegistrations,
    lines: lines.map((line) => ({
      id: line.id,
      taxableMinor: line.netMinor,
      taxCategory: line.taxCategory as TaxContext["lines"][number]["taxCategory"],
      commodityCode: line.commodityCode,
      forceTaxCodeId: line.forcedTaxCodeId,
    })),
    taxInclusive: header.taxInclusive,
    flags: { exportWithIgst: header.exportWithIgst },
  };
}

export function toPreview(currency: string, determined: DetermineResult): TaxPreview {
  const lines = determined.lines.map((line) => ({
    documentLineId: line.documentLineId,
    taxCode: line.taxCode,
    category: line.category as string,
    netMinor: line.taxableMinor,
    taxMinor: line.totalTaxMinor,
    grossMinor: line.taxableMinor + line.totalTaxMinor,
    components: line.components.map((c) => ({
      component: c.code,
      jurisdiction: c.jurisdiction,
      rateBp: c.rateBp,
      taxableMinor: c.taxableMinor,
      taxMinor: c.taxMinor,
      glRole: c.glRole as string,
      accountId: determined.accountByRoleAndComponent.get(`${c.glRole}:${c.code}`) ?? null,
    })),
  }));

  const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
  const taxMinor = lines.reduce((a, l) => a + l.taxMinor, 0);
  const roundingMinor = determined.roundingAdjustmentMinor;

  return {
    currency,
    netMinor,
    taxMinor,
    roundingMinor,
    grossMinor: netMinor + taxMinor + roundingMinor,
    lines,
    errors: determined.errors,
    warnings: determined.warnings,
  };
}
