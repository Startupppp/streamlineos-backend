import { NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
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
    allocations: await loadAllocations(tx, orgId, paymentId),
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

  /*
   * Two queries for the whole page, not two per payment.
   *
   * This loop used to issue `loadAllocations` and `loadWithholding` per row, so
   * a page cost 2 x pageSize round trips — up to 200, serialised on the one
   * pooled connection the request transaction has borrowed, on top of the count
   * and the page itself. The children are now read once each by `inArray` over
   * the page's ids and attached from a Map.
   *
   * No chunking is needed and that is not a guess: `pageSize` is capped at 100
   * by `listApPaymentsQuerySchema` (dto/ap-payments.schemas.ts), so each child
   * query binds at most 101 parameters against the postgres-js ceiling of
   * 65,534. If that cap ever moves, this is the line that has to move with it.
   */
  const paymentIds = rows.map((row) => row.id);
  const [allocationsByPayment, withholdingByPayment] = await Promise.all([
    loadAllocationsByPayment(db, orgId, paymentIds),
    loadWithholdingByPayment(db, orgId, paymentIds),
  ]);

  const items: ApPaymentDto[] = rows.map((row) => ({
    ...toPaymentDto(row),
    allocations: allocationsByPayment.get(row.id) ?? [],
    withholding: withholdingByPayment.get(row.id) ?? [],
  }));
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

/**
 * Every allocation for a set of payments, grouped by payment.
 *
 * `desc(createdAt)` is the order the per-payment version used and is kept, with
 * `desc(id)` added as a tiebreaker. That is deliberate rather than incidental:
 * `ap_allocations.created_at` defaults to `now()`, which in Postgres is
 * TRANSACTION start time, so every allocation written by one `postVendorPayment`
 * shares an identical timestamp and the old per-payment order among those ties
 * was already arbitrary. Grouping in query order only preserves a per-payment
 * order that is defined in the first place, so the tiebreaker is what makes this
 * rewrite order-preserving instead of order-shuffling.
 *
 * `paymentId` is nullable — an allocation may hang off a debit note instead —
 * so a null-keyed row is skipped rather than bucketed under a falsy key.
 */
async function loadAllocationsByPayment(
  tx: DbOrTx,
  orgId: string,
  paymentIds: readonly string[],
): Promise<Map<string, ApAllocationDto[]>> {
  const byPayment = new Map<string, ApAllocationDto[]>();
  if (paymentIds.length === 0) return byPayment;

  const rows = await tx
    .select({
      paymentId: apAllocations.paymentId,
      id: apAllocations.id,
      documentId: apAllocations.documentId,
      amountMinor: apAllocations.amountMinor,
      createdAt: apAllocations.createdAt,
      documentNumber: apDocuments.documentNumber,
      vendorDocumentNumber: apDocuments.vendorDocumentNumber,
    })
    .from(apAllocations)
    .innerJoin(apDocuments, eq(apAllocations.documentId, apDocuments.id))
    .where(
      and(
        eq(apAllocations.orgId, orgId),
        inArray(apAllocations.paymentId, [...paymentIds]),
      ),
    )
    .orderBy(desc(apAllocations.createdAt), desc(apAllocations.id));

  for (const { paymentId, ...allocation } of rows) {
    if (paymentId === null) continue;
    const bucket = byPayment.get(paymentId);
    if (bucket) bucket.push(allocation);
    else byPayment.set(paymentId, [allocation]);
  }
  return byPayment;
}

/** Every withholding row for a set of payments, grouped by payment. Unordered, as the per-payment version was. */
async function loadWithholdingByPayment(
  tx: DbOrTx,
  orgId: string,
  paymentIds: readonly string[],
): Promise<Map<string, ApWithholdingDto[]>> {
  const byPayment = new Map<string, ApWithholdingDto[]>();
  if (paymentIds.length === 0) return byPayment;

  const rows = await tx
    .select({
      paymentId: apWithholding.paymentId,
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
    .where(
      and(
        eq(apWithholding.orgId, orgId),
        inArray(apWithholding.paymentId, [...paymentIds]),
      ),
    );

  for (const { paymentId, ...withholding } of rows) {
    if (paymentId === null) continue;
    const bucket = byPayment.get(paymentId);
    if (bucket) bucket.push(withholding);
    else byPayment.set(paymentId, [withholding]);
  }
  return byPayment;
}

/**
 * The single-payment forms `getPayment` uses. They delegate to the batched
 * readers rather than carrying a second copy of the projection, so the two
 * paths cannot drift — which is how the list path came to order its allocations
 * and the detail path not to.
 */
async function loadAllocations(
  tx: DbOrTx,
  orgId: string,
  paymentId: string,
): Promise<ApAllocationDto[]> {
  return (await loadAllocationsByPayment(tx, orgId, [paymentId])).get(paymentId) ?? [];
}

async function loadWithholding(
  tx: DbOrTx,
  orgId: string,
  paymentId: string,
): Promise<ApWithholdingDto[]> {
  return (await loadWithholdingByPayment(tx, orgId, [paymentId])).get(paymentId) ?? [];
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
