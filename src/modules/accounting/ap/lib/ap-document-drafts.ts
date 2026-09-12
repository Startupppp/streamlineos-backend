import { apDocumentLines, apDocuments } from "../../../../db/schema";
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import type { DbOrTx } from "../../kernel/sequence.service";
import { computeLineNetMinor } from "../ap.math";
import type {
  ApDocumentLineInput,
  CreateApDocumentInput,
  UpdateApDocumentInput,
} from "../dto/ap-documents.schemas";
import type { DocumentRow } from "./ap-document-rows";

/**
 * What a draft is written with. The header builders are pure; every statement
 * runs on the transaction the caller hands in.
 */

/** A new draft's header, with supply nature and reverse charge settled. */
export function draftValues(
  args: {
    orgId: string;
    bookId: string;
    vendorId: string;
    userId: string | null;
    currency: string;
    fxRate: string;
    issueDate: string;
  },
  input: CreateApDocumentInput,
): typeof apDocuments.$inferInsert {
  const supplyNature =
    input.supplyNature ?? (input.reverseCharge ? "reverse_charge" : "domestic_b2b");
  const reverseCharge = input.reverseCharge ?? supplyNature === "reverse_charge";

  return {
    orgId: args.orgId,
    bookId: args.bookId,
    partyId: args.vendorId,
    documentType: input.documentType,
    status: "DRAFT" as const,
    vendorDocumentNumber: input.vendorDocumentNumber ?? null,
    vendorDocumentDate: input.vendorDocumentDate ?? null,
    issueDate: args.issueDate,
    dueDate: input.dueDate ?? null,
    currency: args.currency,
    fxRate: args.fxRate,
    supplyNature,
    reverseCharge,
    blockedInputTax: input.blockedInputTax,
    taxInclusive: input.taxInclusive,
    placeOfSupplyCode: input.placeOfSupplyCode ?? null,
    taxLocationFromCountry: input.taxLocationFromCountry ?? null,
    taxLocationFromRegion: input.taxLocationFromRegion ?? null,
    taxLocationToCountry: input.taxLocationToCountry ?? null,
    taxLocationToRegion: input.taxLocationToRegion ?? null,
    originalDocumentId: input.originalDocumentId ?? null,
    memo: input.memo ?? null,
    reference: input.reference ?? null,
    dimensionProjectId: input.dimensionProjectId ?? null,
    createdBy: args.userId,
  };
}

/**
 * An edited draft's header. A field the edit leaves out keeps its stored value;
 * the vendor number is resolved by the caller, which also needs it for the
 * duplicate-number message.
 */
export function draftPatch(
  existing: DocumentRow,
  input: UpdateApDocumentInput,
  args: {
    vendorId: string;
    vendorDocumentNumber: string | null;
    currency: string;
    fxRate: string;
  },
): Partial<typeof apDocuments.$inferInsert> {
  const supplyNature =
    input.supplyNature ??
    (input.reverseCharge === undefined
      ? existing.supplyNature
      : input.reverseCharge
        ? "reverse_charge"
        : "domestic_b2b");

  return {
    partyId: args.vendorId,
    vendorDocumentNumber: args.vendorDocumentNumber,
    vendorDocumentDate:
      input.vendorDocumentDate === undefined
        ? existing.vendorDocumentDate
        : (input.vendorDocumentDate ?? null),
    issueDate: input.issueDate ? assertIsoDate(input.issueDate) : existing.issueDate,
    dueDate: input.dueDate === undefined ? existing.dueDate : (input.dueDate ?? null),
    currency: args.currency,
    fxRate: args.fxRate,
    supplyNature,
    reverseCharge: input.reverseCharge ?? supplyNature === "reverse_charge",
    blockedInputTax: input.blockedInputTax ?? existing.blockedInputTax,
    taxInclusive: input.taxInclusive ?? existing.taxInclusive,
    placeOfSupplyCode:
      input.placeOfSupplyCode === undefined
        ? existing.placeOfSupplyCode
        : (input.placeOfSupplyCode ?? null),
    taxLocationFromCountry:
      input.taxLocationFromCountry === undefined
        ? existing.taxLocationFromCountry
        : (input.taxLocationFromCountry ?? null),
    taxLocationFromRegion:
      input.taxLocationFromRegion === undefined
        ? existing.taxLocationFromRegion
        : (input.taxLocationFromRegion ?? null),
    taxLocationToCountry:
      input.taxLocationToCountry === undefined
        ? existing.taxLocationToCountry
        : (input.taxLocationToCountry ?? null),
    taxLocationToRegion:
      input.taxLocationToRegion === undefined
        ? existing.taxLocationToRegion
        : (input.taxLocationToRegion ?? null),
    originalDocumentId:
      input.originalDocumentId === undefined
        ? existing.originalDocumentId
        : (input.originalDocumentId ?? null),
    memo: input.memo === undefined ? existing.memo : (input.memo ?? null),
    reference: input.reference === undefined ? existing.reference : (input.reference ?? null),
    dimensionProjectId:
      input.dimensionProjectId === undefined
        ? existing.dimensionProjectId
        : (input.dimensionProjectId ?? null),
  };
}

export async function writeDraftLines(
  tx: DbOrTx,
  orgId: string,
  documentId: string,
  lines: readonly ApDocumentLineInput[],
): Promise<void> {
  await tx.insert(apDocumentLines).values(
    lines.map((line, index) => ({
      orgId,
      documentId,
      lineNo: index + 1,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unit: line.unit ?? null,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxCategory: line.taxCategory,
      commodityCode: line.commodityCode ?? null,
      forcedTaxCodeId: line.forcedTaxCodeId ?? null,
      forcedTaxReason: line.forcedTaxReason ?? null,
      expenseAccountId: line.expenseAccountId ?? null,
      capitalize: line.capitalize,
      lineNetMinor: computeLineNetMinor(
        line.quantityMilli,
        line.unitPriceMinor,
        line.discountMinor,
      ),
      dimensionProjectId: line.dimensionProjectId ?? null,
      dimensionCostCenterId: line.dimensionCostCenterId ?? null,
    })),
  );
}
