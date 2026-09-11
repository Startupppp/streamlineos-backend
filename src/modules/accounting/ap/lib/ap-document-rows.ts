import { apDocumentLines, apDocuments } from "../../../../db/schema";
import { computeLineNetMinor } from "../ap.math";
import type { ApDocumentDetail, ApDocumentLineDto, ApDocumentSummary } from "../ap.types";

/**
 * The one projection every bill and debit-note read selects, and the mapping
 * from it to the response shapes. Services return these DTOs; raw ORM rows
 * never leave a service.
 */

export const DOCUMENT_COLUMNS = {
  id: apDocuments.id,
  bookId: apDocuments.bookId,
  partyId: apDocuments.partyId,
  documentType: apDocuments.documentType,
  status: apDocuments.status,
  documentNumber: apDocuments.documentNumber,
  vendorDocumentNumber: apDocuments.vendorDocumentNumber,
  vendorDocumentDate: apDocuments.vendorDocumentDate,
  issueDate: apDocuments.issueDate,
  dueDate: apDocuments.dueDate,
  currency: apDocuments.currency,
  fxRate: apDocuments.fxRate,
  supplyNature: apDocuments.supplyNature,
  reverseCharge: apDocuments.reverseCharge,
  blockedInputTax: apDocuments.blockedInputTax,
  taxInclusive: apDocuments.taxInclusive,
  placeOfSupplyCode: apDocuments.placeOfSupplyCode,
  taxLocationFromCountry: apDocuments.taxLocationFromCountry,
  taxLocationFromRegion: apDocuments.taxLocationFromRegion,
  taxLocationToCountry: apDocuments.taxLocationToCountry,
  taxLocationToRegion: apDocuments.taxLocationToRegion,
  netMinor: apDocuments.netMinor,
  taxMinor: apDocuments.taxMinor,
  grossMinor: apDocuments.grossMinor,
  roundingMinor: apDocuments.roundingMinor,
  settledMinor: apDocuments.settledMinor,
  functionalGrossMinor: apDocuments.functionalGrossMinor,
  originalDocumentId: apDocuments.originalDocumentId,
  gstrPeriod: apDocuments.gstrPeriod,
  postedJournalId: apDocuments.postedJournalId,
  postedAt: apDocuments.postedAt,
  memo: apDocuments.memo,
  reference: apDocuments.reference,
  dimensionProjectId: apDocuments.dimensionProjectId,
};

export const LINE_COLUMNS = {
  id: apDocumentLines.id,
  lineNo: apDocumentLines.lineNo,
  description: apDocumentLines.description,
  quantityMilli: apDocumentLines.quantityMilli,
  unit: apDocumentLines.unit,
  unitPriceMinor: apDocumentLines.unitPriceMinor,
  discountMinor: apDocumentLines.discountMinor,
  taxCategory: apDocumentLines.taxCategory,
  commodityCode: apDocumentLines.commodityCode,
  forcedTaxCodeId: apDocumentLines.forcedTaxCodeId,
  expenseAccountId: apDocumentLines.expenseAccountId,
  capitalize: apDocumentLines.capitalize,
  lineNetMinor: apDocumentLines.lineNetMinor,
  dimensionProjectId: apDocumentLines.dimensionProjectId,
  dimensionCostCenterId: apDocumentLines.dimensionCostCenterId,
};

/** Exactly the projection above — never the whole row (backend/CLAUDE.md §1). */
export type DocumentRow = Pick<typeof apDocuments.$inferSelect, keyof typeof DOCUMENT_COLUMNS>;
export type LineRow = Pick<typeof apDocumentLines.$inferSelect, keyof typeof LINE_COLUMNS>;

export function computeLineNet(line: LineRow): number {
  return computeLineNetMinor(line.quantityMilli, line.unitPriceMinor, line.discountMinor);
}

export function toSummary(row: DocumentRow & { partyName: string }): ApDocumentSummary {
  return {
    id: row.id,
    bookId: row.bookId,
    partyId: row.partyId,
    partyName: row.partyName,
    documentType: row.documentType,
    status: row.status,
    documentNumber: row.documentNumber,
    vendorDocumentNumber: row.vendorDocumentNumber,
    vendorDocumentDate: row.vendorDocumentDate,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    fxRate: row.fxRate,
    supplyNature: row.supplyNature,
    reverseCharge: row.reverseCharge,
    blockedInputTax: row.blockedInputTax,
    taxInclusive: row.taxInclusive,
    netMinor: row.netMinor,
    taxMinor: row.taxMinor,
    grossMinor: row.grossMinor,
    roundingMinor: row.roundingMinor,
    settledMinor: row.settledMinor,
    openMinor: row.grossMinor - row.settledMinor,
    functionalGrossMinor: row.functionalGrossMinor,
    gstrPeriod: row.gstrPeriod,
    postedJournalId: row.postedJournalId,
    postedAt: row.postedAt,
    memo: row.memo,
    reference: row.reference,
  };
}

export function toDetail(
  row: DocumentRow & { partyName: string },
  lines: ApDocumentLineDto[],
): ApDocumentDetail {
  return {
    ...toSummary(row),
    originalDocumentId: row.originalDocumentId,
    placeOfSupplyCode: row.placeOfSupplyCode,
    taxLocationFromCountry: row.taxLocationFromCountry,
    taxLocationFromRegion: row.taxLocationFromRegion,
    taxLocationToCountry: row.taxLocationToCountry,
    taxLocationToRegion: row.taxLocationToRegion,
    dimensionProjectId: row.dimensionProjectId,
    lines,
  };
}
