/**
 * Receipt and settlement-target rows: the columns a receipt read selects, the
 * plain and locked loads, and the status a document's settlement implies.
 */
import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { arDocuments, arReceipts, type DocumentStatus } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";

export const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

/**
 * Settlement drives status, never the other way round: nothing settled is
 * `POSTED`, everything settled is `PAID`, in between is `PARTIALLY_PAID`.
 */
export function statusFor(settledMinor: number, grossMinor: number): DocumentStatus {
  if (settledMinor <= 0) return "POSTED";
  if (settledMinor >= grossMinor) return "PAID";
  return "PARTIALLY_PAID";
}

export function receiptColumns() {
  return {
    id: arReceipts.id,
    bookId: arReceipts.bookId,
    partyId: arReceipts.partyId,
    receiptNumber: arReceipts.receiptNumber,
    receiptDate: arReceipts.receiptDate,
    depositAccountId: arReceipts.depositAccountId,
    currency: arReceipts.currency,
    fxRate: arReceipts.fxRate,
    amountMinor: arReceipts.amountMinor,
    unappliedMinor: arReceipts.unappliedMinor,
    status: arReceipts.status,
    paymentMethod: arReceipts.paymentMethod,
    reference: arReceipts.reference,
    memo: arReceipts.memo,
    postedJournalId: arReceipts.postedJournalId,
    reversalJournalId: arReceipts.reversalJournalId,
  } as const;
}

export async function loadReceipt(orgId: string, receiptId: string, tx: DbOrTx) {
  const [row] = await tx
    .select(receiptColumns())
    .from(arReceipts)
    .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)))
    .limit(1);
  if (!row) throw new NotFoundException("Receipt not found");
  return row;
}

export async function lockReceipt(orgId: string, receiptId: string, tx: DbOrTx) {
  const [row] = await tx
    .select(receiptColumns())
    .from(arReceipts)
    .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundException("Receipt not found");
  return row;
}

export async function lockDocument(orgId: string, documentId: string, tx: DbOrTx) {
  const [row] = await tx
    .select({
      id: arDocuments.id,
      bookId: arDocuments.bookId,
      partyId: arDocuments.partyId,
      documentType: arDocuments.documentType,
      documentNumber: arDocuments.documentNumber,
      status: arDocuments.status,
      currency: arDocuments.currency,
      grossMinor: arDocuments.grossMinor,
      settledMinor: arDocuments.settledMinor,
    })
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
