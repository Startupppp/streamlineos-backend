import type {
  ApDocumentType,
  DocumentStatus,
  TaxCategory,
  TaxGlRole,
  TaxSupplyNature,
} from "../../../db/schema";
import type { ApAgingBucket } from "./ap.math";

/** Response shapes. Services return these; raw ORM rows never leave a service. */

export interface ApDocumentLineDto {
  id: string;
  lineNo: number;
  description: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  taxCategory: TaxCategory;
  commodityCode: string | null;
  expenseAccountId: string | null;
  capitalize: boolean;
  lineNetMinor: number;
  lineTaxMinor: number;
  lineGrossMinor: number;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
}

export interface ApDocumentSummary {
  id: string;
  bookId: string;
  partyId: string;
  partyName: string;
  documentType: ApDocumentType;
  status: DocumentStatus;
  documentNumber: string | null;
  vendorDocumentNumber: string | null;
  vendorDocumentDate: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  fxRate: string;
  supplyNature: TaxSupplyNature;
  reverseCharge: boolean;
  blockedInputTax: boolean;
  taxInclusive: boolean;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  settledMinor: number;
  /** `gross − settled`, the number aging and allocation both work from. */
  openMinor: number;
  functionalGrossMinor: number;
  gstrPeriod: string | null;
  postedJournalId: string | null;
  postedAt: Date | null;
  memo: string | null;
  reference: string | null;
}

export interface ApDocumentDetail extends ApDocumentSummary {
  originalDocumentId: string | null;
  placeOfSupplyCode: string | null;
  taxLocationFromCountry: string | null;
  taxLocationFromRegion: string | null;
  taxLocationToCountry: string | null;
  taxLocationToRegion: string | null;
  dimensionProjectId: number | null;
  lines: ApDocumentLineDto[];
}

export interface ApTaxComponentPreview {
  component: string;
  jurisdiction: string;
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
  recoverable: boolean;
  glRole: TaxGlRole;
  glAccountId: string | null;
}

export interface ApTaxLinePreview {
  documentLineId: string;
  taxCode: string;
  taxCodeId: string | null;
  category: TaxCategory;
  taxableMinor: number;
  totalTaxMinor: number;
  components: ApTaxComponentPreview[];
}

/**
 * What determination produced for a document, before anything is written.
 *
 * `taxMinor` is what the **vendor** charges — input tax less any reverse-charge
 * output that offsets it — because that is what ends up in accounts payable.
 * `selfAssessedTaxMinor` is the reverse-charge leg the buyer accounts for on
 * both sides; it moves GST but never money, so it is reported separately rather
 * than being folded into a total the vendor never invoiced.
 */
export interface ApTaxPreview {
  documentId: string;
  currency: string;
  netMinor: number;
  taxMinor: number;
  selfAssessedTaxMinor: number;
  blockedTaxMinor: number;
  roundingMinor: number;
  grossMinor: number;
  lines: ApTaxLinePreview[];
  errors: Array<{ code: string; message: string; documentLineId?: string }>;
  warnings: Array<{ code: string; message: string; documentLineId?: string }>;
}

export interface ApPostResult {
  document: ApDocumentDetail;
  journalId: string;
  journalNumber: string;
  /** True when the document was already posted and this call changed nothing. */
  replayed: boolean;
  selfAssessedTaxMinor: number;
}

/* --------------------------------------------------------------- payments */

export interface ApAllocationDto {
  id: string;
  documentId: string;
  documentNumber: string | null;
  vendorDocumentNumber: string | null;
  amountMinor: number;
  createdAt: Date;
}

export interface ApWithholdingDto {
  id: string;
  regime: string;
  legacySection: string | null;
  paymentCode: string | null;
  rateBp: number;
  baseMinor: number;
  withheldMinor: number;
  currency: string;
  glAccountId: string | null;
  remittanceReference: string | null;
}

export interface ApPaymentDto {
  id: string;
  bookId: string;
  partyId: string;
  partyName: string;
  paymentNumber: string | null;
  paymentDate: string;
  paymentAccountId: string;
  currency: string;
  fxRate: string;
  grossMinor: number;
  withheldMinor: number;
  netPaidMinor: number;
  unappliedMinor: number;
  status: "POSTED" | "REVERSED";
  paymentMethod: string | null;
  reference: string | null;
  memo: string | null;
  postedJournalId: string | null;
  reversalJournalId: string | null;
  allocations: ApAllocationDto[];
  withholding: ApWithholdingDto[];
}

export interface ApPaymentPostResult {
  payment: ApPaymentDto;
  journalId: string;
  journalNumber: string;
  replayed: boolean;
}

/* ----------------------------------------------------------------- aging */

export interface ApAgingItem {
  documentId: string;
  documentType: ApDocumentType;
  documentNumber: string | null;
  vendorDocumentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  /**
   * Signed, in document currency: a bill is positive (owed), a debit note is
   * negative (owed back). Summing the column is the payables balance.
   */
  openMinor: number;
  functionalOpenMinor: number;
  daysOverdue: number;
  bucket: ApAgingBucket;
}

export interface ApAgingPartyRow {
  partyId: string;
  partyName: string;
  buckets: Record<ApAgingBucket, number>;
  totalMinor: number;
  items: ApAgingItem[];
}

export interface ApAgingReport {
  bookId: string;
  asOf: string;
  functionalCurrency: string;
  buckets: Record<ApAgingBucket, number>;
  totalMinor: number;
  parties: ApAgingPartyRow[];
  page: number;
  pageSize: number;
  totalParties: number;
}
