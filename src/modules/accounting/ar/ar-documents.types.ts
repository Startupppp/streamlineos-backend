/**
 * The shapes `ArDocumentsService` returns, and the header row and computed line
 * its `lib/ar-document-*.ts` pieces pass between them.
 */
import type { ArDocumentType, DocumentStatus } from "../../../db/schema";
import type { TaxContext, TaxProblem } from "../tax/tax.types";

/* -------------------------------------------------------------- view types */

export interface ArDocumentLineView {
  id: string;
  lineNo: number;
  description: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  taxCategory: string;
  commodityCode: string | null;
  forcedTaxCodeId: string | null;
  forcedTaxReason: string | null;
  incomeAccountId: string | null;
  lineNetMinor: number;
  lineTaxMinor: number;
  lineGrossMinor: number;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
}

export interface ArDocumentView {
  id: string;
  bookId: string;
  partyId: string;
  documentType: ArDocumentType;
  status: DocumentStatus;
  documentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  fxRate: string;
  supplyNature: TaxContext["supplyNature"];
  taxLocationFromCountry: string | null;
  taxLocationFromRegion: string | null;
  taxLocationToCountry: string | null;
  taxLocationToRegion: string | null;
  placeOfSupplyCode: string | null;
  taxInclusive: boolean;
  exportWithIgst: boolean;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  functionalGrossMinor: number;
  settledMinor: number;
  /** `gross - settled`. The one definition of an open item in this module. */
  openMinor: number;
  originalDocumentId: string | null;
  postedJournalId: string | null;
  gstrPeriod: string | null;
  memo: string | null;
  reference: string | null;
  lines: ArDocumentLineView[];
}

export interface ArDocumentPage {
  items: Omit<ArDocumentView, "lines">[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TaxPreviewComponent {
  component: string;
  jurisdiction: string;
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
  glRole: string;
  accountId: string | null;
}

export interface TaxPreview {
  currency: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  lines: Array<{
    documentLineId: string;
    taxCode: string;
    category: string;
    netMinor: number;
    taxMinor: number;
    grossMinor: number;
    components: TaxPreviewComponent[];
  }>;
  errors: TaxProblem[];
  warnings: TaxProblem[];
}

/* ---------------------------------------------------------- internal rows */

/** A line as preview and posting work with it: net from the line maths, tax once determined. */
export interface ComputedLine {
  id: string;
  lineNo: number;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  incomeAccountId: string | null;
  taxCategory: ArDocumentLineView["taxCategory"];
  commodityCode: string | null;
  forcedTaxCodeId: string | null;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
  description: string;
}

/** The header row every read selects — `headerColumns()` in `lib/ar-document-header.ts`. */
export type ArDocumentHeader = {
  id: string;
  bookId: string;
  partyId: string;
  documentType: ArDocumentType;
  status: DocumentStatus;
  documentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  fxRate: string;
  supplyNature: TaxContext["supplyNature"];
  taxLocationFromCountry: string | null;
  taxLocationFromRegion: string | null;
  taxLocationToCountry: string | null;
  taxLocationToRegion: string | null;
  placeOfSupplyCode: string | null;
  taxInclusive: boolean;
  exportWithIgst: boolean;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  functionalGrossMinor: number;
  settledMinor: number;
  originalDocumentId: string | null;
  postedJournalId: string | null;
  gstrPeriod: string | null;
  memo: string | null;
  reference: string | null;
  crmDealId: string | null;
  dimensionProjectId: number | null;
  ecommerceGstin: string | null;
};
