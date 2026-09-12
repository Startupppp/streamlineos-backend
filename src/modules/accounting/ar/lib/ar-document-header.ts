/**
 * The AR document header row: the columns every read selects, the view it maps
 * to, the list's filter, and the two ways to load one — plain, and locked.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { arDocuments, type ArDocumentType, type DocumentStatus } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { ListArDocumentsQuery } from "../dto/ar-documents.schemas";
import type { ArDocumentHeader, ArDocumentView } from "../ar-documents.types";

/** Statuses that still carry an open balance. */
export const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

export function headerColumns() {
  return {
    id: arDocuments.id,
    bookId: arDocuments.bookId,
    partyId: arDocuments.partyId,
    documentType: arDocuments.documentType,
    status: arDocuments.status,
    documentNumber: arDocuments.documentNumber,
    issueDate: arDocuments.issueDate,
    dueDate: arDocuments.dueDate,
    currency: arDocuments.currency,
    fxRate: arDocuments.fxRate,
    supplyNature: arDocuments.supplyNature,
    taxLocationFromCountry: arDocuments.taxLocationFromCountry,
    taxLocationFromRegion: arDocuments.taxLocationFromRegion,
    taxLocationToCountry: arDocuments.taxLocationToCountry,
    taxLocationToRegion: arDocuments.taxLocationToRegion,
    placeOfSupplyCode: arDocuments.placeOfSupplyCode,
    taxInclusive: arDocuments.taxInclusive,
    exportWithIgst: arDocuments.exportWithIgst,
    netMinor: arDocuments.netMinor,
    taxMinor: arDocuments.taxMinor,
    grossMinor: arDocuments.grossMinor,
    roundingMinor: arDocuments.roundingMinor,
    functionalGrossMinor: arDocuments.functionalGrossMinor,
    settledMinor: arDocuments.settledMinor,
    originalDocumentId: arDocuments.originalDocumentId,
    postedJournalId: arDocuments.postedJournalId,
    gstrPeriod: arDocuments.gstrPeriod,
    memo: arDocuments.memo,
    reference: arDocuments.reference,
    crmDealId: arDocuments.crmDealId,
    dimensionProjectId: arDocuments.dimensionProjectId,
    ecommerceGstin: arDocuments.ecommerceGstin,
  } as const;
}

export function toHeaderView(row: ArDocumentHeader): Omit<ArDocumentView, "lines"> {
  return {
    id: row.id,
    bookId: row.bookId,
    partyId: row.partyId,
    documentType: row.documentType,
    status: row.status,
    documentNumber: row.documentNumber,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    fxRate: row.fxRate,
    supplyNature: row.supplyNature,
    taxLocationFromCountry: row.taxLocationFromCountry,
    taxLocationFromRegion: row.taxLocationFromRegion,
    taxLocationToCountry: row.taxLocationToCountry,
    taxLocationToRegion: row.taxLocationToRegion,
    placeOfSupplyCode: row.placeOfSupplyCode,
    taxInclusive: row.taxInclusive,
    exportWithIgst: row.exportWithIgst,
    netMinor: row.netMinor,
    taxMinor: row.taxMinor,
    grossMinor: row.grossMinor,
    roundingMinor: row.roundingMinor,
    functionalGrossMinor: row.functionalGrossMinor,
    settledMinor: row.settledMinor,
    openMinor: row.grossMinor - row.settledMinor,
    originalDocumentId: row.originalDocumentId,
    postedJournalId: row.postedJournalId,
    gstrPeriod: row.gstrPeriod,
    memo: row.memo,
    reference: row.reference,
  };
}

/** The list's WHERE: one book, one document type, no deleted rows, then the caller's filters. */
export function listWhere(
  orgId: string,
  bookId: string,
  documentType: ArDocumentType,
  query: ListArDocumentsQuery,
) {
  const filters = [
    eq(arDocuments.orgId, orgId),
    eq(arDocuments.bookId, bookId),
    eq(arDocuments.documentType, documentType),
    isNull(arDocuments.deletedAt),
  ];
  if (query.partyId) filters.push(eq(arDocuments.partyId, query.partyId));
  if (query.status) filters.push(eq(arDocuments.status, query.status));
  if (query.from) filters.push(gte(arDocuments.issueDate, query.from));
  if (query.to) filters.push(lte(arDocuments.issueDate, query.to));
  if (query.openOnly) {
    filters.push(inArray(arDocuments.status, OPEN_STATUSES));
    filters.push(sql`${arDocuments.grossMinor} > ${arDocuments.settledMinor}`);
  }
  if (query.search) {
    const needle = `%${query.search}%`;
    filters.push(
      or(
        sql`${arDocuments.documentNumber} ILIKE ${needle}`,
        sql`${arDocuments.reference} ILIKE ${needle}`,
      )!,
    );
  }
  return and(...filters);
}

export async function loadHeader(
  orgId: string,
  documentId: string,
  tx: DbOrTx,
): Promise<ArDocumentHeader> {
  const [row] = await tx
    .select(headerColumns())
    .from(arDocuments)
    .where(
      and(
        eq(arDocuments.orgId, orgId),
        eq(arDocuments.id, documentId),
        isNull(arDocuments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Document not found");
  return row;
}

/** `SELECT … FOR UPDATE`, so two posts of the same document serialise. */
export async function lockDocument(
  orgId: string,
  documentId: string,
  tx: DbOrTx,
): Promise<ArDocumentHeader> {
  const [row] = await tx
    .select(headerColumns())
    .from(arDocuments)
    .where(
      and(
        eq(arDocuments.orgId, orgId),
        eq(arDocuments.id, documentId),
        isNull(arDocuments.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundException("Document not found");
  return row;
}

export function assertDraft(header: ArDocumentHeader): void {
  if (header.status !== "DRAFT") {
    throw new ConflictException(
      `${header.documentNumber ?? header.id} is ${header.status} and cannot be edited. ` +
        "Issue a credit note instead.",
    );
  }
}
