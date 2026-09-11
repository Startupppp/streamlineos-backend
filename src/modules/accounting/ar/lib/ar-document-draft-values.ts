/**
 * Draft-side mappers: the row a new draft inserts, the patch an edit applies,
 * and the draft a credit note copies out of an invoice. Pure — the statements
 * run in `ar-document-drafts.ts`, on the caller's transaction.
 */
import type { ArDocumentType, arDocuments } from "../../../../db/schema";
import type { BookSummary } from "../../kernel/books.service";
import type { PartyDetail } from "../../parties/parties.service";
import type {
  ArDocumentLineInput,
  CreateInvoiceInput,
  CreditNoteFromInvoiceInput,
  UpdateDraftInput,
} from "../dto/ar-documents.schemas";
import type { ArDocumentHeader, ArDocumentView } from "../ar-documents.types";

/** What a draft is created from: an invoice's fields, plus the invoice a credit note corrects. */
export type ArDraftInput = CreateInvoiceInput & { originalDocumentId?: string | null };

type ArDocumentInsert = typeof arDocuments.$inferInsert;

export function defaultDueDate(issueDate: string, paymentTermsDays: number): string {
  const [y, m, d] = issueDate.split("-").map(Number);
  const due = new Date(Date.UTC(y, m - 1, d + paymentTermsDays));
  return due.toISOString().slice(0, 10);
}

/** The row a new draft inserts. Anything the caller left out defaults from the party or the book. */
export function newDraftValues(args: {
  orgId: string;
  userId: string | null;
  documentType: ArDocumentType;
  book: BookSummary;
  party: PartyDetail;
  input: ArDraftInput;
  currency: string;
  fxRate: string;
}): ArDocumentInsert {
  const { orgId, userId, documentType, book, party, input, currency, fxRate } = args;
  return {
    orgId,
    bookId: book.id,
    partyId: party.id,
    documentType,
    status: "DRAFT",
    issueDate: input.issueDate,
    dueDate: input.dueDate ?? defaultDueDate(input.issueDate, party.paymentTermsDays),
    currency,
    fxRate,
    supplyNature: input.supplyNature ?? "domestic_b2b",
    taxLocationFromCountry: input.taxLocationFromCountry ?? book.countryCode,
    taxLocationFromRegion: input.taxLocationFromRegion ?? null,
    taxLocationToCountry:
      input.taxLocationToCountry ?? party.billingCountryCode ?? party.countryCode,
    taxLocationToRegion: input.taxLocationToRegion ?? party.billingRegion ?? null,
    placeOfSupplyCode: input.placeOfSupplyCode ?? party.billingRegion ?? null,
    taxInclusive: input.taxInclusive ?? false,
    exportWithIgst: input.exportWithIgst ?? false,
    originalDocumentId: input.originalDocumentId ?? null,
    memo: input.memo ?? null,
    reference: input.reference ?? null,
    crmDealId: input.crmDealId ?? null,
    dimensionProjectId: input.dimensionProjectId ?? null,
    ecommerceGstin: input.ecommerceGstin ?? null,
    createdBy: userId,
  };
}

/** The patch an edit applies to a draft. A field the caller left out keeps its current value. */
export function draftPatch(args: {
  current: ArDocumentHeader;
  patch: UpdateDraftInput;
  book: BookSummary;
  party: PartyDetail;
  partyId: string;
  issueDate: string;
  currency: string;
  fxRate: string;
}): Partial<ArDocumentInsert> {
  const { current, patch, book, party, partyId, issueDate, currency, fxRate } = args;
  return {
    partyId,
    issueDate,
    dueDate:
      patch.dueDate === undefined
        ? current.dueDate
        : (patch.dueDate ?? defaultDueDate(issueDate, party.paymentTermsDays)),
    currency,
    fxRate,
    supplyNature: patch.supplyNature ?? current.supplyNature,
    taxLocationFromCountry:
      patch.taxLocationFromCountry ?? current.taxLocationFromCountry ?? book.countryCode,
    taxLocationFromRegion:
      patch.taxLocationFromRegion === undefined
        ? current.taxLocationFromRegion
        : patch.taxLocationFromRegion,
    taxLocationToCountry:
      patch.taxLocationToCountry ??
      current.taxLocationToCountry ??
      party.billingCountryCode ??
      party.countryCode,
    taxLocationToRegion:
      patch.taxLocationToRegion === undefined
        ? current.taxLocationToRegion
        : patch.taxLocationToRegion,
    placeOfSupplyCode:
      patch.placeOfSupplyCode === undefined
        ? current.placeOfSupplyCode
        : patch.placeOfSupplyCode,
    taxInclusive: patch.taxInclusive ?? current.taxInclusive,
    exportWithIgst: patch.exportWithIgst ?? current.exportWithIgst,
    originalDocumentId:
      patch.originalDocumentId === undefined
        ? current.originalDocumentId
        : patch.originalDocumentId,
    memo: patch.memo === undefined ? current.memo : patch.memo,
    reference: patch.reference === undefined ? current.reference : patch.reference,
    crmDealId: patch.crmDealId === undefined ? current.crmDealId : patch.crmDealId,
    dimensionProjectId:
      patch.dimensionProjectId === undefined
        ? current.dimensionProjectId
        : patch.dimensionProjectId,
    ecommerceGstin:
      patch.ecommerceGstin === undefined ? current.ecommerceGstin : patch.ecommerceGstin,
  };
}

/**
 * The draft a credit note starts as: the invoice's lines unless the caller named
 * some, and the invoice's party, currency, rate and tax setting.
 */
export function creditNoteDraftFrom(
  invoice: ArDocumentView,
  input: CreditNoteFromInvoiceInput,
): ArDraftInput {
  const lines: ArDocumentLineInput[] =
    input.lines ??
    invoice.lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
      unit: line.unit,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxCategory: line.taxCategory as ArDocumentLineInput["taxCategory"],
      commodityCode: line.commodityCode,
      forcedTaxCodeId: line.forcedTaxCodeId,
      forcedTaxReason: line.forcedTaxReason,
      incomeAccountId: line.incomeAccountId,
      dimensionProjectId: line.dimensionProjectId,
      dimensionCostCenterId: line.dimensionCostCenterId,
    }));

  return {
    partyId: invoice.partyId,
    issueDate: input.issueDate ?? invoice.issueDate,
    dueDate: null,
    currency: invoice.currency,
    fxRate: invoice.fxRate,
    supplyNature: invoice.supplyNature,
    taxLocationFromCountry: invoice.taxLocationFromCountry,
    taxLocationFromRegion: invoice.taxLocationFromRegion,
    taxLocationToCountry: invoice.taxLocationToCountry,
    taxLocationToRegion: invoice.taxLocationToRegion,
    placeOfSupplyCode: invoice.placeOfSupplyCode,
    taxInclusive: invoice.taxInclusive,
    exportWithIgst: invoice.exportWithIgst,
    originalDocumentId: invoice.id,
    memo: input.memo ?? `Credit note against ${invoice.documentNumber ?? invoice.id}`,
    reference: input.reference ?? invoice.documentNumber,
    lines,
  };
}
