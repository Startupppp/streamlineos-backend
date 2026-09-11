import { NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import {
  apAllocations,
  apDocuments,
  apPayments,
  apWithholding,
  glParties,
} from "../../../../db/schema";
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { ApAllocationDto, ApPaymentDto, ApWithholdingDto } from "../ap.types";
import type { ListApPaymentsQuery } from "../dto/ap-payments.schemas";

/**
 * Reads of vendor payments, each on the reader it is handed. A payment comes
 * back with its allocations and its withholding rows attached.
 */

const PAYMENT_COLUMNS = {
  id: apPayments.id,
  bookId: apPayments.bookId,
  partyId: apPayments.partyId,
  paymentNumber: apPayments.paymentNumber,
  paymentDate: apPayments.paymentDate,
  paymentAccountId: apPayments.paymentAccountId,
  currency: apPayments.currency,
  fxRate: apPayments.fxRate,
  grossMinor: apPayments.grossMinor,
  withheldMinor: apPayments.withheldMinor,
  netPaidMinor: apPayments.netPaidMinor,
  unappliedMinor: apPayments.unappliedMinor,
  status: apPayments.status,
  paymentMethod: apPayments.paymentMethod,
  reference: apPayments.reference,
  memo: apPayments.memo,
  postedJournalId: apPayments.postedJournalId,
  reversalJournalId: apPayments.reversalJournalId,
};

type PaymentRow = Pick<typeof apPayments.$inferSelect, keyof typeof PAYMENT_COLUMNS>;

export async function getPayment(
  tx: DbOrTx,
  orgId: string,
  paymentId: string,
): Promise<ApPaymentDto> {
  const [row] = await tx
    .select({ ...PAYMENT_COLUMNS, partyName: glParties.displayName })
    .from(apPayments)
    .innerJoin(glParties, eq(apPayments.partyId, glParties.id))
    .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)))
    .limit(1);
  if (!row) throw new NotFoundException("Payment not found");

  return {
    ...toPaymentDto(row),
    allocations: await loadAllocations(tx, orgId, { paymentId }),
    withholding: await loadWithholding(tx, orgId, paymentId),
  };
}

/** One page of a book's payments; the caller resolves which book. */
export async function listPayments(
  db: DbOrTx,
  orgId: string,
  bookId: string,
  query: ListApPaymentsQuery,
): Promise<{ items: ApPaymentDto[]; page: number; pageSize: number; total: number }> {
  const filters = [eq(apPayments.orgId, orgId), eq(apPayments.bookId, bookId)];
  if (query.partyId) filters.push(eq(apPayments.partyId, query.partyId));
  if (query.status) filters.push(eq(apPayments.status, query.status));
  if (query.from) filters.push(gte(apPayments.paymentDate, assertIsoDate(query.from)));
  if (query.to) filters.push(lte(apPayments.paymentDate, assertIsoDate(query.to)));
  const where = and(...filters);

  const [{ total }] = await db.select({ total: count() }).from(apPayments).where(where);
  const rows = await db
    .select({ ...PAYMENT_COLUMNS, partyName: glParties.displayName })
    .from(apPayments)
    .innerJoin(glParties, eq(apPayments.partyId, glParties.id))
    .where(where)
    .orderBy(desc(apPayments.paymentDate), desc(apPayments.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items: ApPaymentDto[] = [];
  for (const row of rows) {
    items.push({
      ...toPaymentDto(row),
      allocations: await loadAllocations(db, orgId, { paymentId: row.id }),
      withholding: await loadWithholding(db, orgId, row.id),
    });
  }
  return { items, page: query.page, pageSize: query.pageSize, total: Number(total) };
}

export async function loadPaymentForUpdate(tx: DbOrTx, orgId: string, paymentId: string) {
  const [row] = await tx
    .select(PAYMENT_COLUMNS)
    .from(apPayments)
    .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundException("Payment not found");
  return row;
}

async function loadAllocations(
  tx: DbOrTx,
  orgId: string,
  by: { paymentId?: string; debitNoteId?: string },
): Promise<ApAllocationDto[]> {
  const filters = [eq(apAllocations.orgId, orgId)];
  if (by.paymentId) filters.push(eq(apAllocations.paymentId, by.paymentId));
  if (by.debitNoteId) filters.push(eq(apAllocations.debitNoteId, by.debitNoteId));

  const rows = await tx
    .select({
      id: apAllocations.id,
      documentId: apAllocations.documentId,
      amountMinor: apAllocations.amountMinor,
      createdAt: apAllocations.createdAt,
      documentNumber: apDocuments.documentNumber,
      vendorDocumentNumber: apDocuments.vendorDocumentNumber,
    })
    .from(apAllocations)
    .innerJoin(apDocuments, eq(apAllocations.documentId, apDocuments.id))
    .where(and(...filters))
    .orderBy(desc(apAllocations.createdAt));
  return rows;
}

async function loadWithholding(
  tx: DbOrTx,
  orgId: string,
  paymentId: string,
): Promise<ApWithholdingDto[]> {
  return tx
    .select({
      id: apWithholding.id,
      regime: apWithholding.regime,
      legacySection: apWithholding.legacySection,
      paymentCode: apWithholding.paymentCode,
      rateBp: apWithholding.rateBp,
      baseMinor: apWithholding.baseMinor,
      withheldMinor: apWithholding.withheldMinor,
      currency: apWithholding.currency,
      glAccountId: apWithholding.glAccountId,
      remittanceReference: apWithholding.remittanceReference,
    })
    .from(apWithholding)
    .where(and(eq(apWithholding.orgId, orgId), eq(apWithholding.paymentId, paymentId)));
}

function toPaymentDto(row: PaymentRow & { partyName: string }): Omit<
  ApPaymentDto,
  "allocations" | "withholding"
> {
  return {
    id: row.id,
    bookId: row.bookId,
    partyId: row.partyId,
    partyName: row.partyName,
    paymentNumber: row.paymentNumber,
    paymentDate: row.paymentDate,
    paymentAccountId: row.paymentAccountId,
    currency: row.currency,
    fxRate: row.fxRate,
    grossMinor: row.grossMinor,
    withheldMinor: row.withheldMinor,
    netPaidMinor: row.netPaidMinor,
    unappliedMinor: row.unappliedMinor,
    status: row.status,
    paymentMethod: row.paymentMethod,
    reference: row.reference,
    memo: row.memo,
    postedJournalId: row.postedJournalId,
    reversalJournalId: row.reversalJournalId,
  };
}
