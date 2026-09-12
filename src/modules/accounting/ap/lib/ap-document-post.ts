import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  apDocumentLines,
  apDocuments,
  type ApDocumentType,
  type GlJournalSource,
} from "../../../../db/schema";
import type { BooksService } from "../../kernel/books.service";
import type { LedgerService } from "../../kernel/ledger.service";
import { convert, money } from "../../kernel/money";
import type { DbOrTx, SequenceService } from "../../kernel/sequence.service";
import type { PackRegistry } from "../../packs/pack.registry";
import type { DocumentSeriesKind } from "../../packs/pack.types";
import type { TaxService } from "../../tax/tax.service";
import { periodKeyOf } from "../ap.math";
import { toJournalLines } from "../ap.posting";
import type { ApPostResult } from "../ap.types";
import { requireVendor } from "../ap.vendor-lookup";
import { buildJournalDrafts } from "./ap-document-journal";
import { getDocumentDetail, loadDocumentRowForUpdate, loadLineRows } from "./ap-document-reads";
import { computeTotals, withResolvedTaxAccounts } from "./ap-document-tax";

const SEQUENCE_KIND: Record<ApDocumentType, DocumentSeriesKind> = {
  BILL: "purchaseBill",
  DEBIT_NOTE: "debitNote",
};

const JOURNAL_SOURCE: Record<ApDocumentType, GlJournalSource> = {
  BILL: "purchase_bill",
  DEBIT_NOTE: "debit_note",
};

/** The collaborators a post needs, handed over by the service that owns them. */
export interface ApDocumentPostingDeps {
  books: BooksService;
  ledger: LedgerService;
  sequences: SequenceService;
  tax: TaxService;
  packs: PackRegistry;
}

/**
 * Freeze the document and post its journal, on the caller's transaction.
 *
 * A bill debits expense or asset per line, debits the recoverable tax per
 * component, and credits AP with the gross. A debit note is the exact mirror.
 * Every account comes from the book's tag map or the tax GL map keyed
 * `glRole:component`; nothing here knows an account code.
 *
 * Reverse charge posts **both** legs the engine returns, so the GST nets to
 * zero on the supply and accounts payable carries only what the vendor is
 * actually owed. There is no `if (country === 'IN')` — AP simply obeys the
 * `glRole` on each component.
 */
export async function postDocument(
  deps: ApDocumentPostingDeps,
  tx: DbOrTx,
  orgId: string,
  userId: string | null,
  documentId: string,
): Promise<ApPostResult> {
  const { books, ledger, sequences, tax, packs } = deps;
  const doc = await loadDocumentRowForUpdate(tx, orgId, documentId);

  // Posting twice is a no-op, not a second journal (PRD 03 acceptance 7).
  if (doc.status !== "DRAFT") {
    if (!doc.postedJournalId) {
      throw new ConflictException(`A ${doc.status} document cannot be posted`);
    }
    const journal = await ledger.loadJournal(orgId, doc.postedJournalId, tx);
    return {
      document: await getDocumentDetail(tx, orgId, documentId),
      journalId: doc.postedJournalId,
      journalNumber: journal?.journalNumber ?? "",
      replayed: true,
      selfAssessedTaxMinor: 0,
    } satisfies ApPostResult;
  }

  const book = await books.get(orgId, doc.bookId, tx);
  const vendor = await requireVendor(tx, orgId, doc.bookId, doc.partyId);
  const lines = await loadLineRows(tx, documentId);
  if (lines.length === 0) throw new BadRequestException("A document needs at least one line");

  const totals = await computeTotals(tax, tx, doc, lines, vendor, book.countryCode, tx);
  if (totals.determination.errors.length > 0) {
    throw new BadRequestException({
      message: "Tax could not be determined for this document",
      errors: totals.determination.errors,
    });
  }
  if (totals.netMinor < 0 || totals.grossMinor <= 0) {
    throw new BadRequestException(
      "A document must post a positive amount; check the line quantities and discounts",
    );
  }

  const fiscalYear = await books.ensureFiscalYear(orgId, doc.bookId, doc.issueDate, tx);
  const pack = packs.get(book.localizationPack);
  const documentNumber = await sequences.allocate(
    {
      orgId,
      bookId: doc.bookId,
      kind: SEQUENCE_KIND[doc.documentType],
      series: pack.documentSeries[SEQUENCE_KIND[doc.documentType]],
      fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
    },
    tx,
  );

  const drafts = await buildJournalDrafts(books, tx, doc, lines, vendor, totals);
  const roundingAccountId = await books.resolveAccountByTag(doc.bookId, "rounding", tx);
  const sourceType = JOURNAL_SOURCE[doc.documentType];

  const journal = await ledger.post(
    orgId,
    userId,
    {
      bookId: doc.bookId,
      idempotencyKey: `${sourceType}:${doc.id}:post`,
      journalDate: doc.issueDate,
      memo:
        doc.memo ??
        `${doc.documentType === "BILL" ? "Bill" : "Debit note"} ${documentNumber} — ${vendor.displayName}`,
      sourceType,
      sourceId: doc.id,
      lines: toJournalLines({
        drafts,
        currency: doc.currency,
        functionalCurrency: book.baseCurrency,
        fxRate: doc.fxRate,
        roundingAccountId,
        roundingMinor:
          doc.documentType === "BILL" ? totals.roundingMinor : -totals.roundingMinor,
        roundingDescription: "Tax rounding adjustment",
      }),
    },
    tx,
  );

  await tax.freezeDocumentTaxLines(
    orgId,
    doc.bookId,
    sourceType,
    doc.id,
    doc.currency,
    withResolvedTaxAccounts(totals.determination, await blockedAccountId(books, doc.bookId, tx)),
    tx,
  );

  const functionalGrossMinor =
    doc.currency === book.baseCurrency
      ? totals.grossMinor
      : convert(money(totals.grossMinor, doc.currency), book.baseCurrency, doc.fxRate).minor;

  await tx
    .update(apDocuments)
    .set({
      status: "POSTED",
      documentNumber,
      netMinor: totals.netMinor,
      taxMinor: totals.taxMinor,
      grossMinor: totals.grossMinor,
      roundingMinor: totals.roundingMinor,
      functionalGrossMinor,
      gstrPeriod: periodKeyOf(doc.issueDate),
      postedJournalId: journal.id,
      postedBy: userId,
      postedAt: new Date(),
    })
    .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, doc.id)));

  for (const line of lines) {
    const computed = totals.perLine.get(line.id);
    if (!computed) continue;
    await tx
      .update(apDocumentLines)
      .set({
        lineNetMinor: computed.netMinor,
        lineTaxMinor: computed.taxMinor,
        lineGrossMinor: computed.grossMinor,
      })
      .where(eq(apDocumentLines.id, line.id));
  }

  return {
    document: await getDocumentDetail(tx, orgId, doc.id),
    journalId: journal.id,
    journalNumber: journal.journalNumber,
    replayed: journal.replayed,
    selfAssessedTaxMinor: totals.selfAssessedTaxMinor,
  } satisfies ApPostResult;
}

async function blockedAccountId(books: BooksService, bookId: string, tx: DbOrTx): Promise<string> {
  return books.resolveAccountByTag(bookId, "opex", tx);
}
