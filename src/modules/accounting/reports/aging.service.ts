import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { apDocuments, arDocuments, glAccounts, glParties } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { convert, isCurrencyCode, money } from "../kernel/money";
import { csvMoney, toCsv, withCsvPreamble } from "./report-csv";
import { label, type LabelMode, type ReportLabelKey } from "./report-labels";
import {
  daysBetween,
  ledgerSigned,
  negated,
  readAccountMovements,
  resolveReportBook,
} from "./report-queries";

export type AgingSide = "ar" | "ap";
export type AgingBasis = "due" | "issue";
export type AgingBucketKey = "0-30" | "31-60" | "61-90" | "91+";

export const AGING_BUCKETS: readonly {
  key: AgingBucketKey;
  labelKey: ReportLabelKey;
  minDays: number;
  maxDays: number | null;
}[] = Object.freeze([
  { key: "0-30", labelKey: "bucket.0_30", minDays: Number.NEGATIVE_INFINITY, maxDays: 30 },
  { key: "31-60", labelKey: "bucket.31_60", minDays: 31, maxDays: 60 },
  { key: "61-90", labelKey: "bucket.61_90", minDays: 61, maxDays: 90 },
  { key: "91+", labelKey: "bucket.91_plus", minDays: 91, maxDays: null },
]);

/** Documents that still carry an open item. A draft has no ledger effect. */
const OPEN_STATUSES = ["POSTED", "PARTIALLY_PAID"] as const;

const MAX_DOCUMENT_DETAIL = 500;

export interface AgingQuery {
  side: AgingSide;
  asOf: string;
  bookId?: string;
  /** Age from the due date (collections view) or the issue date (audit view). */
  basis?: AgingBasis;
  includeDocuments?: boolean;
  labelMode?: LabelMode;
}

export type AgingBuckets = Record<AgingBucketKey, number>;

export interface AgingPartyRow {
  partyId: string;
  partyName: string;
  buckets: AgingBuckets;
  totalMinor: number;
  documentCount: number;
  /** Days past the basis date of the oldest open item. Negative = not yet due. */
  oldestAgeDays: number;
}

export interface AgingDocumentRow {
  documentId: string;
  documentNumber: string | null;
  documentType: string;
  partyId: string;
  partyName: string;
  issueDate: string;
  dueDate: string | null;
  basisDate: string;
  ageDays: number;
  bucket: AgingBucketKey;
  currency: string;
  openMinor: number;
  functionalOpenMinor: number;
}

export interface AgingReport {
  reportKey: "aging";
  side: AgingSide;
  title: string;
  labelMode: LabelMode;
  bookId: string;
  currency: string;
  asOf: string;
  basis: AgingBasis;
  bucketLabels: Record<AgingBucketKey, string>;
  parties: AgingPartyRow[];
  totals: AgingBuckets;
  totalOpenMinor: number;
  documents: AgingDocumentRow[] | null;
  documentsTruncated: boolean;
  /** Signed in the control account's natural direction (AR debit, AP credit). */
  controlAccountCode: string | null;
  controlAccountBalanceMinor: number;
  /** Open items minus control balance. Zero, or something is wrong. */
  differenceMinor: number;
  reconciles: boolean;
  notes: string[];
}

/**
 * AR and AP ageing from open items, reconciled to the control account.
 *
 * The reconciliation is the feature. An ageing report that does not tie to the
 * general ledger is a spreadsheet with opinions — someone chases a customer for
 * money the books say arrived last week, and the credibility of the whole
 * module goes with it. So every run returns the sub-ledger total, the GL
 * control balance and the difference, and says plainly whether they agree.
 */
@Injectable()
export class AgingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  async run(orgId: string, query: AgingQuery): Promise<AgingReport> {
    const asOf = assertIsoDate(query.asOf);
    const mode: LabelMode = query.labelMode ?? "founder";
    const basis: AgingBasis = query.basis ?? "due";
    const side = query.side;
    const book = await resolveReportBook(this.books, orgId, query.bookId);

    const rows = await this.readOpenItems(orgId, book.id, side, asOf);

    const documents: AgingDocumentRow[] = [];
    const byParty = new Map<string, AgingPartyRow>();
    const totals = emptyBuckets();
    let totalOpenMinor = 0;

    for (const row of rows) {
      const rawOpen = row.grossMinor - row.settledMinor;
      if (rawOpen === 0) continue;

      // A credit note reduces what the customer owes; a debit note reduces
      // what we owe a vendor. Signing them here is what lets the total tie to
      // the control account instead of overstating both sides.
      const sign = this.signOf(side, row.documentType);
      const openMinor = rawOpen * sign;
      const functionalOpenMinor = this.toFunctional(openMinor, row.currency, row.fxRate, book.baseCurrency);

      const basisDate = basis === "due" ? (row.dueDate ?? row.issueDate) : row.issueDate;
      const ageDays = daysBetween(basisDate, asOf);
      const bucket = bucketFor(ageDays);

      totals[bucket] += functionalOpenMinor;
      totalOpenMinor += functionalOpenMinor;

      let party = byParty.get(row.partyId);
      if (!party) {
        party = {
          partyId: row.partyId,
          partyName: row.partyName,
          buckets: emptyBuckets(),
          totalMinor: 0,
          documentCount: 0,
          oldestAgeDays: ageDays,
        };
        byParty.set(row.partyId, party);
      }
      party.buckets[bucket] += functionalOpenMinor;
      party.totalMinor += functionalOpenMinor;
      party.documentCount += 1;
      party.oldestAgeDays = Math.max(party.oldestAgeDays, ageDays);

      if (query.includeDocuments && documents.length < MAX_DOCUMENT_DETAIL) {
        documents.push({
          documentId: row.documentId,
          documentNumber: row.documentNumber,
          documentType: row.documentType,
          partyId: row.partyId,
          partyName: row.partyName,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          basisDate,
          ageDays,
          bucket,
          currency: row.currency,
          openMinor,
          functionalOpenMinor,
        });
      }
    }

    const parties = [...byParty.values()].sort((a, b) => b.totalMinor - a.totalMinor);

    const control = await this.controlBalance(orgId, book.id, side, asOf);
    const differenceMinor = totalOpenMinor - control.balanceMinor;

    const notes: string[] = [
      "Open items are the current settled amount subtracted from the document gross. A document " +
        "settled after the as-of date therefore shows as settled here — historic ageing is a " +
        "point-in-time snapshot of today's settlement, not a rewind of it.",
      "Draft and void documents are excluded; only POSTED and PARTIALLY_PAID carry an open item.",
    ];
    if (!control.accountCode) {
      notes.push(
        `No account is tagged ${side === "ar" ? "ar_control" : "ap_control"} in this book, so ` +
          "there is nothing to reconcile against. Re-run the chart of accounts setup.",
      );
    }
    if (documents.length >= MAX_DOCUMENT_DETAIL) {
      notes.push(
        `Document detail was capped at ${MAX_DOCUMENT_DETAIL} rows. The party rows and totals ` +
          "cover every open item.",
      );
    }

    return {
      reportKey: "aging",
      side,
      title: label(side === "ar" ? "report.aging_ar" : "report.aging_ap", mode),
      labelMode: mode,
      bookId: book.id,
      currency: book.baseCurrency,
      asOf,
      basis,
      bucketLabels: Object.fromEntries(
        AGING_BUCKETS.map((b) => [b.key, label(b.labelKey, mode)]),
      ) as Record<AgingBucketKey, string>,
      parties,
      totals,
      totalOpenMinor,
      documents: query.includeDocuments ? documents : null,
      documentsTruncated: documents.length >= MAX_DOCUMENT_DETAIL,
      controlAccountCode: control.accountCode,
      controlAccountBalanceMinor: control.balanceMinor,
      differenceMinor,
      reconciles: differenceMinor === 0,
      notes,
    };
  }

  /* ------------------------------------------------------------- reading */

  private async readOpenItems(orgId: string, bookId: string, side: AgingSide, asOf: string) {
    if (side === "ar") {
      return this.db
        .select({
          documentId: arDocuments.id,
          documentNumber: arDocuments.documentNumber,
          documentType: arDocuments.documentType,
          partyId: arDocuments.partyId,
          partyName: glParties.displayName,
          issueDate: arDocuments.issueDate,
          dueDate: arDocuments.dueDate,
          currency: arDocuments.currency,
          fxRate: arDocuments.fxRate,
          grossMinor: arDocuments.grossMinor,
          settledMinor: arDocuments.settledMinor,
        })
        .from(arDocuments)
        .innerJoin(glParties, eq(arDocuments.partyId, glParties.id))
        .where(
          and(
            eq(arDocuments.orgId, orgId),
            eq(arDocuments.bookId, bookId),
            inArray(arDocuments.status, [...OPEN_STATUSES]),
            isNull(arDocuments.deletedAt),
            lte(arDocuments.issueDate, asOf),
          ),
        )
        .orderBy(asc(arDocuments.issueDate));
    }

    return this.db
      .select({
        documentId: apDocuments.id,
        documentNumber: apDocuments.documentNumber,
        documentType: apDocuments.documentType,
        partyId: apDocuments.partyId,
        partyName: glParties.displayName,
        issueDate: apDocuments.issueDate,
        dueDate: apDocuments.dueDate,
        currency: apDocuments.currency,
        fxRate: apDocuments.fxRate,
        grossMinor: apDocuments.grossMinor,
        settledMinor: apDocuments.settledMinor,
      })
      .from(apDocuments)
      .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.bookId, bookId),
          inArray(apDocuments.status, [...OPEN_STATUSES]),
          isNull(apDocuments.deletedAt),
          lte(apDocuments.issueDate, asOf),
        ),
      )
      .orderBy(asc(apDocuments.issueDate));
  }

  private async controlBalance(orgId: string, bookId: string, side: AgingSide, asOf: string) {
    const tag = side === "ar" ? "ar_control" : "ap_control";
    const movements = await readAccountMovements(this.db, { orgId, bookId, to: asOf });
    const control = movements.find((m) => m.systemTag === tag);
    if (!control) {
      // Either the tag is missing or nothing has ever posted there. Both mean a
      // control balance of zero; the note distinguishes them for the reader.
      const accountCode = await this.controlAccountCode(bookId, tag);
      return { accountCode, balanceMinor: 0 };
    }
    const signed = ledgerSigned(control.debitMinor, control.creditMinor);
    return {
      accountCode: control.code,
      balanceMinor: side === "ar" ? signed : negated(signed),
    };
  }

  private async controlAccountCode(bookId: string, tag: "ar_control" | "ap_control") {
    const [row] = await this.db
      .select({ code: glAccounts.code })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.systemTag, tag),
          isNull(glAccounts.deletedAt),
        ),
      )
      .limit(1);
    return row?.code ?? null;
  }

  private signOf(side: AgingSide, documentType: string): 1 | -1 {
    if (side === "ar") return documentType === "CREDIT_NOTE" ? -1 : 1;
    return documentType === "DEBIT_NOTE" ? -1 : 1;
  }

  /**
   * Convert an open item into functional currency at the document's own frozen
   * rate. Never at today's rate — the ledger recorded the receivable at the
   * rate on the invoice, and the control account still carries that number.
   */
  private toFunctional(
    openMinor: number,
    currency: string,
    fxRate: string,
    baseCurrency: string,
  ): number {
    if (currency === baseCurrency) return openMinor;
    if (!isCurrencyCode(currency) || !isCurrencyCode(baseCurrency)) return openMinor;
    try {
      return convert(money(openMinor, currency), baseCurrency, fxRate).minor;
    } catch {
      return openMinor;
    }
  }

  /* ----------------------------------------------------------------- csv */

  async csv(orgId: string, query: AgingQuery): Promise<string> {
    const report = await this.run(orgId, query);
    const c = report.currency;
    const bucketKeys = AGING_BUCKETS.map((b) => b.key);

    const rows: (string | number)[][] = report.parties.map((p) => [
      p.partyName,
      ...bucketKeys.map((k) => csvMoney(p.buckets[k], c)),
      csvMoney(p.totalMinor, c),
      p.documentCount,
      p.oldestAgeDays,
    ]);
    rows.push([
      "TOTAL",
      ...bucketKeys.map((k) => csvMoney(report.totals[k], c)),
      csvMoney(report.totalOpenMinor, c),
      "",
      "",
    ]);

    return withCsvPreamble(
      [
        ["Report", report.title],
        ["As of", report.asOf],
        ["Aged by", report.basis === "due" ? "due date" : "issue date"],
        ["Currency", c],
        ["Control account", report.controlAccountCode ?? "(not configured)"],
        ["Control account balance", csvMoney(report.controlAccountBalanceMinor, c)],
        ["Open items total", csvMoney(report.totalOpenMinor, c)],
        ["Reconciles", report.reconciles ? "yes" : "no"],
        ["Difference", csvMoney(report.differenceMinor, c)],
        ...report.notes.map((n, i) => [`Note ${i + 1}`, n] as const),
      ],
      toCsv(
        [
          label("column.party", report.labelMode),
          ...bucketKeys.map((k) => report.bucketLabels[k]),
          "Total",
          "Open documents",
          "Oldest (days)",
        ],
        rows,
      ),
    );
  }
}

function emptyBuckets(): AgingBuckets {
  return { "0-30": 0, "31-60": 0, "61-90": 0, "91+": 0 };
}

/** Anything not yet due lands in `0-30`; nothing falls between two buckets. */
export function bucketFor(ageDays: number): AgingBucketKey {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "91+";
}
