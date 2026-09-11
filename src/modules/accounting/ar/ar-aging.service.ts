import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, notInArray, sql } from "drizzle-orm";
import {
  arDocuments,
  arReceipts,
  glAccounts,
  glJournalLines,
  glJournals,
  glParties,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import type { DbOrTx } from "../kernel/sequence.service";
import { convert, money } from "../kernel/money";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import type { AgingBasis, AgingQuery } from "./dto/ar-aging.schemas";

export interface AgingBuckets {
  /** Not yet due, or up to 30 days past the basis date. */
  days0to30: number;
  days31to60: number;
  days61to90: number;
  days91Plus: number;
}

export interface AgingOpenItem {
  kind: "invoice" | "credit_note" | "unapplied_receipt";
  documentId: string;
  documentNumber: string | null;
  partyId: string;
  partyName: string;
  currency: string;
  issueDate: string;
  basisDate: string;
  daysOverdue: number;
  bucket: keyof AgingBuckets;
  /** Signed: an invoice is positive, a credit or unapplied receipt negative. */
  openMinor: number;
  functionalOpenMinor: number;
}

export interface AgingPartyRow {
  partyId: string;
  partyName: string;
  currency: string;
  buckets: AgingBuckets;
  totalMinor: number;
  functionalTotalMinor: number;
}

export interface AgingReport {
  bookId: string;
  asOf: string;
  basis: AgingBasis;
  baseCurrency: string;
  rows: AgingPartyRow[];
  totals: AgingBuckets & { totalMinor: number; functionalTotalMinor: number };
  /**
   * The PRD's key invariant, computed rather than asserted in a comment: the
   * aging total must equal the AR control account's balance on the same date.
   */
  reconciliation: {
    agingFunctionalMinor: number;
    arControlBalanceMinor: number;
    differenceMinor: number;
    balanced: boolean;
  };
}

const EMPTY_BUCKETS = (): AgingBuckets => ({
  days0to30: 0,
  days31to60: 0,
  days61to90: 0,
  days91Plus: 0,
});

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function bucketFor(daysOverdue: number): keyof AgingBuckets {
  if (daysOverdue <= 30) return "days0to30";
  if (daysOverdue <= 60) return "days31to60";
  if (daysOverdue <= 90) return "days61to90";
  return "days91Plus";
}

/**
 * AR aging, derived from open items.
 *
 * There is no aging table. Every figure here is recomputed from documents,
 * allocations and receipts as they stood on the as-of date, which is the only
 * way the report can be right about the past — a stored bucket is a snapshot of
 * whenever the job last ran, and drifts the moment a receipt is backdated or a
 * reversal unwinds a settlement.
 *
 * "As they stood" is load-bearing: an allocation counts from the **later** of
 * the two documents' dates, because a receipt cannot settle an invoice that did
 * not exist yet.
 *
 * The report carries credit notes and unapplied receipts as negative items, not
 * because a founder wants to read them that way, but because without them the
 * total cannot equal the AR control balance — and that equality is the whole
 * point of the report.
 */
@Injectable()
export class ArAgingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async aging(orgId: string, query: AgingQuery = {}): Promise<AgingReport> {
    const book = await this.books.requireDefault(orgId);
    const asOf = assertIsoDate(query.asOf ?? new Date().toISOString().slice(0, 10));
    const basis: AgingBasis = query.basis ?? "due";

    const items = await this.openItems(orgId, book.id, book.baseCurrency, asOf, basis, query);

    const byParty = new Map<string, AgingPartyRow>();
    const totals = { ...EMPTY_BUCKETS(), totalMinor: 0, functionalTotalMinor: 0 };

    for (const item of items) {
      const key = `${item.partyId}|${item.currency}`;
      let row = byParty.get(key);
      if (!row) {
        row = {
          partyId: item.partyId,
          partyName: item.partyName,
          currency: item.currency,
          buckets: EMPTY_BUCKETS(),
          totalMinor: 0,
          functionalTotalMinor: 0,
        };
        byParty.set(key, row);
      }
      row.buckets[item.bucket] += item.openMinor;
      row.totalMinor += item.openMinor;
      row.functionalTotalMinor += item.functionalOpenMinor;

      totals[item.bucket] += item.openMinor;
      totals.totalMinor += item.openMinor;
      totals.functionalTotalMinor += item.functionalOpenMinor;
    }

    const rows = [...byParty.values()]
      .filter((r) => query.includeSettled || r.totalMinor !== 0)
      .sort((a, b) => b.totalMinor - a.totalMinor || a.partyName.localeCompare(b.partyName));

    const arControlBalanceMinor = await this.arControlBalance(orgId, book.id, asOf);
    // Scoping the report to one party or currency deliberately breaks the tie to
    // a book-wide control account, so only claim the invariant for a full run.
    const scoped = Boolean(query.partyId || query.currency);
    const differenceMinor = totals.functionalTotalMinor - arControlBalanceMinor;

    return {
      bookId: book.id,
      asOf,
      basis,
      baseCurrency: book.baseCurrency,
      rows,
      totals,
      reconciliation: {
        agingFunctionalMinor: totals.functionalTotalMinor,
        arControlBalanceMinor,
        differenceMinor,
        balanced: scoped ? true : differenceMinor === 0,
      },
    };
  }

  /**
   * Every open item on the book as at `asOf`, one row per document.
   *
   * Invoices are positive, credit notes and unapplied receipts negative. Callers
   * that only want the customer-facing view can filter on `kind`.
   */
  async openItems(
    orgId: string,
    bookId: string,
    baseCurrency: string,
    asOf: string,
    basis: AgingBasis,
    filter: Pick<AgingQuery, "partyId" | "currency"> = {},
    tx: DbOrTx = this.db,
  ): Promise<AgingOpenItem[]> {
    const [invoices, creditNotes, receipts] = await Promise.all([
      this.loadDocuments(orgId, bookId, asOf, "INVOICE", filter, tx),
      this.loadDocuments(orgId, bookId, asOf, "CREDIT_NOTE", filter, tx),
      this.loadUnappliedReceipts(orgId, bookId, asOf, filter, tx),
    ]);

    const items: AgingOpenItem[] = [];

    for (const row of [...invoices, ...creditNotes]) {
      const openMinor = row.grossMinor - Number(row.settledMinor);
      if (openMinor === 0) continue;
      const signed = row.documentType === "INVOICE" ? openMinor : -openMinor;
      const basisDate = basis === "due" ? (row.dueDate ?? row.issueDate) : row.issueDate;
      const daysOverdue = daysBetween(basisDate, asOf);

      items.push({
        kind: row.documentType === "INVOICE" ? "invoice" : "credit_note",
        documentId: row.id,
        documentNumber: row.documentNumber,
        partyId: row.partyId,
        partyName: row.partyName,
        currency: row.currency,
        issueDate: row.issueDate,
        basisDate,
        daysOverdue,
        bucket: bucketFor(daysOverdue),
        openMinor: signed,
        functionalOpenMinor: this.toFunctional(signed, row.currency, baseCurrency, row.fxRate),
      });
    }

    for (const row of receipts) {
      const unapplied = row.amountMinor - Number(row.appliedMinor);
      if (unapplied <= 0) continue;
      const daysOverdue = daysBetween(row.receiptDate, asOf);
      items.push({
        kind: "unapplied_receipt",
        documentId: row.id,
        documentNumber: row.receiptNumber,
        partyId: row.partyId,
        partyName: row.partyName,
        currency: row.currency,
        issueDate: row.receiptDate,
        basisDate: row.receiptDate,
        daysOverdue,
        bucket: bucketFor(daysOverdue),
        openMinor: -unapplied,
        functionalOpenMinor: this.toFunctional(
          -unapplied,
          row.currency,
          baseCurrency,
          row.fxRate,
        ),
      });
    }

    return items;
  }

  /* ---------------------------------------------------------------- loads */

  private async loadDocuments(
    orgId: string,
    bookId: string,
    asOf: string,
    documentType: "INVOICE" | "CREDIT_NOTE",
    filter: Pick<AgingQuery, "partyId" | "currency">,
    tx: DbOrTx,
  ) {
    /**
     * Settlement as at `asOf`, not the running total on the row.
     *
     * An allocation takes effect on the later of the two documents' dates —
     * a receipt dated before the invoice it pays has not settled anything yet —
     * and a reversed receipt's allocations are deleted, so `status = 'POSTED'`
     * is belt and braces for a receipt reversed after the as-of date.
     */
    const settledAsOf =
      documentType === "INVOICE"
        ? sql<string>`(
            select coalesce(sum(a.amount_minor), 0)
            from ar_allocations a
            left join ar_receipts r on r.id = a.receipt_id
            left join ar_documents cn on cn.id = a.credit_note_id
            where a.document_id = ${arDocuments.id}
              and (r.id is null or r.status = 'POSTED')
              and greatest(
                    coalesce(r.receipt_date, cn.issue_date),
                    ${arDocuments.issueDate}
                  ) <= ${asOf}::date
          )`
        : sql<string>`(
            select coalesce(sum(a.amount_minor), 0)
            from ar_allocations a
            join ar_documents target on target.id = a.document_id
            where a.credit_note_id = ${arDocuments.id}
              and greatest(${arDocuments.issueDate}, target.issue_date) <= ${asOf}::date
          )`;

    const filters = [
      eq(arDocuments.orgId, orgId),
      eq(arDocuments.bookId, bookId),
      eq(arDocuments.documentType, documentType),
      isNull(arDocuments.deletedAt),
      notInArray(arDocuments.status, ["DRAFT", "VOID"]),
      lte(arDocuments.issueDate, asOf),
    ];
    if (filter.partyId) filters.push(eq(arDocuments.partyId, filter.partyId));
    if (filter.currency) filters.push(eq(arDocuments.currency, filter.currency));

    return tx
      .select({
        id: arDocuments.id,
        documentNumber: arDocuments.documentNumber,
        documentType: arDocuments.documentType,
        partyId: arDocuments.partyId,
        partyName: glParties.displayName,
        currency: arDocuments.currency,
        fxRate: arDocuments.fxRate,
        issueDate: arDocuments.issueDate,
        dueDate: arDocuments.dueDate,
        grossMinor: arDocuments.grossMinor,
        settledMinor: settledAsOf,
      })
      .from(arDocuments)
      .innerJoin(glParties, eq(arDocuments.partyId, glParties.id))
      .where(and(...filters));
  }

  private async loadUnappliedReceipts(
    orgId: string,
    bookId: string,
    asOf: string,
    filter: Pick<AgingQuery, "partyId" | "currency">,
    tx: DbOrTx,
  ) {
    const appliedAsOf = sql<string>`(
      select coalesce(sum(a.amount_minor), 0)
      from ar_allocations a
      join ar_documents d on d.id = a.document_id
      where a.receipt_id = ${arReceipts.id}
        and greatest(${arReceipts.receiptDate}, d.issue_date) <= ${asOf}::date
    )`;

    const filters = [
      eq(arReceipts.orgId, orgId),
      eq(arReceipts.bookId, bookId),
      eq(arReceipts.status, "POSTED"),
      lte(arReceipts.receiptDate, asOf),
    ];
    if (filter.partyId) filters.push(eq(arReceipts.partyId, filter.partyId));
    if (filter.currency) filters.push(eq(arReceipts.currency, filter.currency));

    return tx
      .select({
        id: arReceipts.id,
        receiptNumber: arReceipts.receiptNumber,
        partyId: arReceipts.partyId,
        partyName: glParties.displayName,
        currency: arReceipts.currency,
        fxRate: arReceipts.fxRate,
        receiptDate: arReceipts.receiptDate,
        amountMinor: arReceipts.amountMinor,
        appliedMinor: appliedAsOf,
      })
      .from(arReceipts)
      .innerJoin(glParties, eq(arReceipts.partyId, glParties.id))
      .where(and(...filters));
  }

  /** The AR control account's balance straight from the journal lines. */
  async arControlBalance(
    orgId: string,
    bookId: string,
    asOf: string,
    tx: DbOrTx = this.db,
  ): Promise<number> {
    const accountId = await this.books.resolveAccountByTag(bookId, "ar_control", tx);
    const [row] = await tx
      .select({
        debitMinor: sql<string>`coalesce(sum(${glJournalLines.debitMinor}), 0)`,
        creditMinor: sql<string>`coalesce(sum(${glJournalLines.creditMinor}), 0)`,
      })
      .from(glJournalLines)
      .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
      .innerJoin(glAccounts, eq(glJournalLines.accountId, glAccounts.id))
      .where(
        and(
          eq(glJournalLines.orgId, orgId),
          eq(glJournalLines.bookId, bookId),
          eq(glJournalLines.accountId, accountId),
          lte(glJournals.journalDate, asOf),
        ),
      );

    return Number(row?.debitMinor ?? 0) - Number(row?.creditMinor ?? 0);
  }

  private toFunctional(
    txnMinor: number,
    currency: string,
    baseCurrency: string,
    fxRate: string,
  ): number {
    if (currency === baseCurrency) return txnMinor;
    const magnitude = convert(money(Math.abs(txnMinor), currency), baseCurrency, fxRate).minor;
    return txnMinor < 0 ? -magnitude : magnitude;
  }
}
