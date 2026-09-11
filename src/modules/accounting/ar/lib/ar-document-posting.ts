/**
 * Posting an AR document: compute, determine, number, freeze and post. The body
 * of `ArDocumentsService.post`'s transaction — every statement runs on the `tx`
 * it is handed, so a document is never posted without its ledger entry.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { arDocumentLines, arDocuments, type ArDocumentType } from "../../../../db/schema";
import type { ComplianceService } from "../../compliance/compliance.service";
import type { BooksService } from "../../kernel/books.service";
import type { LedgerService } from "../../kernel/ledger.service";
import type { PostedJournal } from "../../kernel/ledger.types";
import type { DbOrTx, SequenceService } from "../../kernel/sequence.service";
import type { PackRegistry } from "../../packs/pack.registry";
import type { DocumentSeriesKind } from "../../packs/pack.types";
import type { PartiesService } from "../../parties/parties.service";
import type { TaxService } from "../../tax/tax.service";
import type { ArDocumentView } from "../ar-documents.types";
import { lockDocument } from "./ar-document-header";
import { SOURCE_TYPE, buildJournalCommand } from "./ar-document-journal";
import { loadComputedLines, readArDocument } from "./ar-document-lines";
import { resolveFiscalYear } from "./ar-document-lookups";
import { toFunctional } from "./ar-document-maths";
import { buildTaxContext } from "./ar-document-tax";

const SERIES_KIND: Record<ArDocumentType, DocumentSeriesKind> = {
  INVOICE: "salesInvoice",
  CREDIT_NOTE: "creditNote",
};

/** The documents service's own collaborators, handed over rather than exposed. */
export interface ArDocumentPostingDeps {
  books: BooksService;
  ledger: LedgerService;
  sequences: SequenceService;
  packs: PackRegistry;
  tax: TaxService;
  parties: PartiesService;
  compliance: ComplianceService;
}

/**
 * Posting twice is safe from two directions at once: the row lock plus the
 * status check catch the sequential double-click, and the ledger's
 * `(book, idempotency_key)` unique catches the genuinely concurrent one. Both
 * callers get the same journal; there is never a second one.
 */
export async function postDocumentInTx(
  deps: ArDocumentPostingDeps,
  orgId: string,
  userId: string | null,
  documentId: string,
  tx: DbOrTx,
): Promise<{ document: ArDocumentView; journal: PostedJournal }> {
  const header = await lockDocument(orgId, documentId, tx);

  if (header.status !== "DRAFT") {
    if (!header.postedJournalId) {
      throw new ConflictException(`Document ${documentId} is ${header.status} but has no journal`);
    }
    const existing = await deps.ledger.loadJournal(orgId, header.postedJournalId, tx);
    if (!existing) throw new ConflictException("The document's journal is missing");
    return { document: await readArDocument(orgId, documentId, tx), journal: { ...existing, replayed: true } };
  }

  const book = await deps.books.get(orgId, header.bookId, tx);
  const party = await deps.parties.requireForBook(orgId, header.bookId, header.partyId, tx);
  const computed = await loadComputedLines(documentId, tx);
  if (computed.length === 0) throw new BadRequestException("A document needs at least one line");

  // Hoisted rather than inlined: the compliance record below needs to know
  // whether each side is tax-registered, and that is settled here.
  const taxContext = await buildTaxContext(deps.tax, header, party, computed, tx);
  const determined = await deps.tax.determine(header.bookId, taxContext, tx);
  if (determined.errors.length > 0) {
    throw new BadRequestException({
      message: "Tax determination failed",
      errors: determined.errors,
    });
  }

  // The engine owns the net once inclusive tax has been backed out, so its
  // answer replaces what the line arithmetic produced.
  const byLine = new Map(determined.lines.map((l) => [l.documentLineId, l]));
  for (const line of computed) {
    const resolved = byLine.get(line.id);
    if (!resolved) {
      throw new BadRequestException(`The tax engine returned no result for line ${line.lineNo}`);
    }
    line.netMinor = resolved.taxableMinor;
    line.taxMinor = resolved.totalTaxMinor;
    line.grossMinor = resolved.taxableMinor + resolved.totalTaxMinor;
  }

  const netMinor = computed.reduce((a, l) => a + l.netMinor, 0);
  const taxMinor = computed.reduce((a, l) => a + l.taxMinor, 0);
  const roundingMinor = determined.roundingAdjustmentMinor;
  const grossMinor = netMinor + taxMinor + roundingMinor;
  if (grossMinor <= 0) {
    throw new BadRequestException("A document must total more than zero to be posted");
  }

  const fiscalYear = await resolveFiscalYear(header.bookId, header.issueDate, tx);
  const pack = deps.packs.get(book.localizationPack);
  const documentNumber = await deps.sequences.allocate(
    {
      orgId,
      bookId: header.bookId,
      kind: SERIES_KIND[header.documentType],
      series: pack.documentSeries[SERIES_KIND[header.documentType]],
      fiscalYear,
    },
    tx,
  );

  await deps.tax.freezeDocumentTaxLines(
    orgId,
    header.bookId,
    SOURCE_TYPE[header.documentType],
    documentId,
    header.currency,
    determined,
    tx,
  );

  const command = await buildJournalCommand(deps.books, {
    orgId,
    header,
    party,
    book,
    computed,
    determined,
    netMinor,
    taxMinor,
    grossMinor,
    documentNumber,
    tx,
  });

  const journal = await deps.ledger.post(orgId, userId, command, tx);

  const functionalGrossMinor = toFunctional(
    grossMinor,
    header.currency,
    book.baseCurrency,
    header.fxRate,
  );

  await tx
    .update(arDocuments)
    .set({
      status: "POSTED",
      documentNumber,
      postedJournalId: journal.id,
      postedBy: userId,
      postedAt: new Date(),
      netMinor,
      taxMinor,
      grossMinor,
      roundingMinor,
      functionalGrossMinor,
      // `YYYY-MM` from the issue date — the return period this supply lands in.
      gstrPeriod: header.issueDate.slice(0, 7),
    })
    .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));

  for (const line of computed) {
    await tx
      .update(arDocumentLines)
      .set({
        lineNetMinor: line.netMinor,
        lineTaxMinor: line.taxMinor,
        lineGrossMinor: line.grossMinor,
      })
      .where(eq(arDocumentLines.id, line.id));
  }

  /**
   * Record whether this document would need reporting to a tax authority
   * (PRD 13). v1 writes the transport and a `pending` status and calls
   * nothing — enforcement is `off`, so a document posts whether or not the
   * authority is reachable. A founder losing the ability to invoice because
   * a government endpoint is down is not a trade worth making.
   */
  await deps.compliance.recordForDocument(
    orgId,
    book.id,
    header.documentType === "CREDIT_NOTE" ? "credit_note" : "sales_invoice",
    documentId,
    {
      supplyNature: header.supplyNature,
      sellerHasTaxId: taxContext.sellerRegistrations.length > 0,
      buyerHasTaxId: taxContext.buyerRegistrations.length > 0,
    },
    tx,
  );

  return { document: await readArDocument(orgId, documentId, tx), journal };
}
