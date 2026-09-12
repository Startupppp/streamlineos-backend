import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { apAllocations, apDocuments, apPayments, glParties } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { convert, money } from "../kernel/money";
import { AP_AGING_BUCKETS, bucketFor, daysBetween, type ApAgingBucket } from "./ap.math";
import type { ApAgingItem, ApAgingPartyRow, ApAgingReport } from "./ap.types";
import type { ApAgingQuery } from "./dto/ap-aging.schemas";

function emptyBuckets(): Record<ApAgingBucket, number> {
  return { "0-30": 0, "31-60": 0, "61-90": 0, "91+": 0 };
}

/**
 * Aged payables.
 *
 * Derived from open items every time, never from a stored balance — the whole
 * reason `settled_minor` and the allocation rows both exist is so the report
 * and the ledger cannot drift apart. Its acceptance test is exactly that: the
 * aging total must equal the AP control account's balance in the GL.
 *
 * "As of" is honoured properly. Settlement is recomputed from the allocations
 * that were **effective on that date**, so running last month's aging today
 * gives last month's answer rather than today's balances wearing last month's
 * header. A debit note carries a negative open amount, because it reduces what
 * is owed.
 */
@Injectable()
export class ApAgingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async agedPayables(orgId: string, query: ApAgingQuery): Promise<ApAgingReport> {
    const book = query.bookId
      ? await this.books.get(orgId, query.bookId)
      : await this.books.requireDefault(orgId);
    const asOf = assertIsoDate(query.asOf ?? new Date().toISOString().slice(0, 10));

    const filters = [
      eq(apDocuments.orgId, orgId),
      eq(apDocuments.bookId, book.id),
      isNull(apDocuments.deletedAt),
      isNotNull(apDocuments.postedJournalId),
      lte(apDocuments.issueDate, asOf),
      inArray(apDocuments.status, ["POSTED", "PARTIALLY_PAID", "PAID"]),
    ];
    if (query.partyId) filters.push(eq(apDocuments.partyId, query.partyId));

    const documents = await this.db
      .select({
        id: apDocuments.id,
        partyId: apDocuments.partyId,
        partyName: glParties.displayName,
        documentType: apDocuments.documentType,
        documentNumber: apDocuments.documentNumber,
        vendorDocumentNumber: apDocuments.vendorDocumentNumber,
        issueDate: apDocuments.issueDate,
        dueDate: apDocuments.dueDate,
        currency: apDocuments.currency,
        fxRate: apDocuments.fxRate,
        grossMinor: apDocuments.grossMinor,
      })
      .from(apDocuments)
      .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
      .where(and(...filters));

    const settled = await this.settledAsOf(orgId, book.id, asOf);

    const byParty = new Map<string, ApAgingPartyRow>();
    const totals = emptyBuckets();
    let totalMinor = 0;

    for (const doc of documents) {
      const openMinor = doc.grossMinor - (settled.get(doc.id) ?? 0);
      if (openMinor === 0) continue;

      // A debit note is money owed back, so it ages as a negative open item —
      // the same sign it carries in the AP control account.
      const signed = doc.documentType === "DEBIT_NOTE" ? -openMinor : openMinor;
      const functionalOpenMinor =
        doc.currency === book.baseCurrency
          ? signed
          : convert(money(signed, doc.currency), book.baseCurrency, doc.fxRate).minor;

      const daysOverdue = daysBetween(doc.dueDate ?? doc.issueDate, asOf);
      const bucket = bucketFor(daysOverdue);

      let row = byParty.get(doc.partyId);
      if (!row) {
        row = {
          partyId: doc.partyId,
          partyName: doc.partyName,
          buckets: emptyBuckets(),
          totalMinor: 0,
          items: [],
        };
        byParty.set(doc.partyId, row);
      }

      row.buckets[bucket] += functionalOpenMinor;
      row.totalMinor += functionalOpenMinor;
      totals[bucket] += functionalOpenMinor;
      totalMinor += functionalOpenMinor;

      if (query.includeItems) {
        row.items.push({
          documentId: doc.id,
          documentType: doc.documentType,
          documentNumber: doc.documentNumber,
          vendorDocumentNumber: doc.vendorDocumentNumber,
          issueDate: doc.issueDate,
          dueDate: doc.dueDate,
          currency: doc.currency,
          openMinor: signed,
          functionalOpenMinor,
          daysOverdue,
          bucket,
        } satisfies ApAgingItem);
      }
    }

    const parties = [...byParty.values()].sort((a, b) => b.totalMinor - a.totalMinor);
    const start = (query.page - 1) * query.pageSize;

    return {
      bookId: book.id,
      asOf,
      functionalCurrency: book.baseCurrency,
      buckets: totals,
      totalMinor,
      parties: parties.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      totalParties: parties.length,
    };
  }

  /**
   * What each document had been settled by, on the as-of date.
   *
   * Two sources, and both have to be dated: a payment counts from its payment
   * date and only while it is still `POSTED`, and a debit-note application
   * counts once both documents exist. The debit note is credited on both sides
   * of its own allocation — the bill it cleared *and* itself — or the note
   * would keep showing a full open balance it no longer has.
   */
  private async settledAsOf(
    orgId: string,
    bookId: string,
    asOf: string,
  ): Promise<Map<string, number>> {
    const settled = new Map<string, number>();
    const add = (documentId: string, amount: number) =>
      settled.set(documentId, (settled.get(documentId) ?? 0) + amount);

    const fromPayments = await this.db
      .select({
        documentId: apAllocations.documentId,
        amountMinor: sql<string>`sum(${apAllocations.amountMinor})`,
      })
      .from(apAllocations)
      .innerJoin(apPayments, eq(apAllocations.paymentId, apPayments.id))
      .where(
        and(
          eq(apAllocations.orgId, orgId),
          eq(apAllocations.bookId, bookId),
          eq(apPayments.status, "POSTED"),
          lte(apPayments.paymentDate, asOf),
        ),
      )
      .groupBy(apAllocations.documentId);

    for (const row of fromPayments) add(row.documentId, Number(row.amountMinor));

    const note = alias(apDocuments, "debit_note");
    const bill = alias(apDocuments, "settled_bill");
    const fromDebitNotes = await this.db
      .select({
        billId: apAllocations.documentId,
        debitNoteId: apAllocations.debitNoteId,
        amountMinor: apAllocations.amountMinor,
      })
      .from(apAllocations)
      .innerJoin(note, eq(apAllocations.debitNoteId, note.id))
      .innerJoin(bill, eq(apAllocations.documentId, bill.id))
      .where(
        and(
          eq(apAllocations.orgId, orgId),
          eq(apAllocations.bookId, bookId),
          isNotNull(apAllocations.debitNoteId),
          isNotNull(note.postedJournalId),
          isNotNull(bill.postedJournalId),
          lte(note.issueDate, asOf),
          lte(bill.issueDate, asOf),
        ),
      );

    for (const row of fromDebitNotes) {
      add(row.billId, row.amountMinor);
      if (row.debitNoteId) add(row.debitNoteId, row.amountMinor);
    }

    return settled;
  }

  /** The bucket labels, in order, so a UI need not hardcode them. */
  buckets(): readonly ApAgingBucket[] {
    return AP_AGING_BUCKETS;
  }
}
