import { NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { apDocumentLines, apDocuments, glParties } from "../../../../db/schema";
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { ApDocumentDetail, ApDocumentLineDto, ApDocumentSummary } from "../ap.types";
import type { ListApDocumentsQuery } from "../dto/ap-documents.schemas";
import {
  DOCUMENT_COLUMNS,
  LINE_COLUMNS,
  toDetail,
  toSummary,
  type DocumentRow,
  type LineRow,
} from "./ap-document-rows";

/**
 * Reads of bills and debit notes. Each takes the reader it runs on, so a read
 * made inside a posting transaction stays inside that transaction.
 */

export async function getDocumentDetail(
  tx: DbOrTx,
  orgId: string,
  documentId: string,
): Promise<ApDocumentDetail> {
  const [row] = await tx
    .select({ ...DOCUMENT_COLUMNS, partyName: glParties.displayName })
    .from(apDocuments)
    .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.id, documentId),
        isNull(apDocuments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Document not found");

  const lines = await loadLines(tx, documentId);
  return toDetail(row, lines);
}

/** One page of a book's documents; the caller resolves which book. */
export async function listDocuments(
  db: DbOrTx,
  orgId: string,
  bookId: string,
  query: ListApDocumentsQuery,
): Promise<{ items: ApDocumentSummary[]; page: number; pageSize: number; total: number }> {
  const filters = [
    eq(apDocuments.orgId, orgId),
    eq(apDocuments.bookId, bookId),
    isNull(apDocuments.deletedAt),
  ];
  if (query.documentType) filters.push(eq(apDocuments.documentType, query.documentType));
  if (query.status) filters.push(eq(apDocuments.status, query.status));
  if (query.partyId) filters.push(eq(apDocuments.partyId, query.partyId));
  if (query.from) filters.push(gte(apDocuments.issueDate, assertIsoDate(query.from)));
  if (query.to) filters.push(lte(apDocuments.issueDate, assertIsoDate(query.to)));
  if (query.openOnly) {
    filters.push(inArray(apDocuments.status, ["POSTED", "PARTIALLY_PAID"]));
    filters.push(sql`${apDocuments.grossMinor} > ${apDocuments.settledMinor}`);
  }

  const where = and(...filters);
  const [{ total }] = await db
    .select({ total: count() })
    .from(apDocuments)
    .where(where);

  const rows = await db
    .select({ ...DOCUMENT_COLUMNS, partyName: glParties.displayName })
    .from(apDocuments)
    .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
    .where(where)
    .orderBy(desc(apDocuments.issueDate), desc(apDocuments.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((r) => toSummary(r)),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(total),
  };
}

export async function loadDocumentRow(
  tx: DbOrTx,
  orgId: string,
  documentId: string,
): Promise<DocumentRow> {
  const [row] = await tx
    .select(DOCUMENT_COLUMNS)
    .from(apDocuments)
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.id, documentId),
        isNull(apDocuments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Document not found");
  return row;
}

/**
 * Row lock while posting, so two concurrent posts of the same bill serialise
 * and the second sees `POSTED` rather than racing to allocate a second
 * number. The ledger's idempotency key is the backstop; this is the fence.
 */
export async function loadDocumentRowForUpdate(
  tx: DbOrTx,
  orgId: string,
  documentId: string,
): Promise<DocumentRow> {
  const [row] = await tx
    .select(DOCUMENT_COLUMNS)
    .from(apDocuments)
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.id, documentId),
        isNull(apDocuments.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundException("Document not found");
  return row;
}

export async function loadLineRows(tx: DbOrTx, documentId: string): Promise<LineRow[]> {
  return tx
    .select(LINE_COLUMNS)
    .from(apDocumentLines)
    .where(eq(apDocumentLines.documentId, documentId))
    .orderBy(asc(apDocumentLines.lineNo));
}

async function loadLines(tx: DbOrTx, documentId: string): Promise<ApDocumentLineDto[]> {
  const rows = await tx
    .select({
      ...LINE_COLUMNS,
      lineTaxMinor: apDocumentLines.lineTaxMinor,
      lineGrossMinor: apDocumentLines.lineGrossMinor,
    })
    .from(apDocumentLines)
    .where(eq(apDocumentLines.documentId, documentId))
    .orderBy(asc(apDocumentLines.lineNo));
  return rows.map((r) => ({
    id: r.id,
    lineNo: r.lineNo,
    description: r.description,
    quantityMilli: r.quantityMilli,
    unit: r.unit,
    unitPriceMinor: r.unitPriceMinor,
    discountMinor: r.discountMinor,
    taxCategory: r.taxCategory,
    commodityCode: r.commodityCode,
    expenseAccountId: r.expenseAccountId,
    capitalize: r.capitalize,
    lineNetMinor: r.lineNetMinor,
    lineTaxMinor: r.lineTaxMinor,
    lineGrossMinor: r.lineGrossMinor,
    dimensionProjectId: r.dimensionProjectId,
    dimensionCostCenterId: r.dimensionCostCenterId,
  }));
}
