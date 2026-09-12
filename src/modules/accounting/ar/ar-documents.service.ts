import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { arDocuments, taxDocumentLines, type ArDocumentType } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { PackRegistry } from "../packs/pack.registry";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import type { PostedJournal } from "../kernel/ledger.types";
import { TaxService } from "../tax/tax.service";
import { ComplianceService } from "../compliance/compliance.service";
import { PartiesService } from "../parties/parties.service";
import type {
  CreateCreditNoteInput,
  CreateInvoiceInput,
  CreditNoteFromInvoiceInput,
  ListArDocumentsQuery,
  UpdateDraftInput,
} from "./dto/ar-documents.schemas";
import type { ArDocumentPage, ArDocumentView, TaxPreview } from "./ar-documents.types";
import { creditNoteDraftFrom, type ArDraftInput } from "./lib/ar-document-draft-values";
import { createDraftInTx, updateDraftInTx } from "./lib/ar-document-drafts";
import {
  assertDraft,
  headerColumns,
  listWhere,
  loadHeader,
  lockDocument,
  toHeaderView,
} from "./lib/ar-document-header";
import { loadComputedLines, readArDocument } from "./lib/ar-document-lines";
import { postDocumentInTx } from "./lib/ar-document-posting";
import { buildTaxContext, toPreview } from "./lib/ar-document-tax";

export { computeLineNetMinor } from "./lib/ar-document-maths";
export type {
  ArDocumentPage,
  ArDocumentView,
  TaxPreview,
} from "./ar-documents.types";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Sales invoices and credit notes.
 *
 * A credit note is a signed invoice, so it is the same table, the same maths and
 * the same posting routine with the debits and credits swapped. Two code paths
 * would be two open-item calculations that could disagree.
 *
 * The service computes and emits a `PostJournalCommand`; it never writes a
 * journal line. Posting a document and posting its journal happen in **one**
 * transaction, so a document is never posted without its ledger entry.
 *
 * The pieces sit in `lib/ar-document-*.ts` — posting, the journal it emits, tax
 * context and preview, draft writes and mappers, header and line reads, lookups
 * and line maths. Each runs on the `tx` this service hands it.
 */
@Injectable()
export class ArDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly packs: PackRegistry,
    private readonly tax: TaxService,
    private readonly parties: PartiesService,
    private readonly compliance: ComplianceService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async get(orgId: string, documentId: string, tx: DbOrTx = this.db): Promise<ArDocumentView> {
    return readArDocument(orgId, documentId, tx);
  }

  async list(
    orgId: string,
    documentType: ArDocumentType,
    query: ListArDocumentsQuery = {},
  ): Promise<ArDocumentPage> {
    const book = await this.books.requireDefault(orgId);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where = listWhere(orgId, book.id, documentType, query);

    const [items, [counted]] = await Promise.all([
      this.db
        .select(headerColumns())
        .from(arDocuments)
        .where(where)
        .orderBy(desc(arDocuments.issueDate), desc(arDocuments.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: sql<string>`count(*)` }).from(arDocuments).where(where),
    ]);

    return {
      items: items.map((row) => toHeaderView(row)),
      page,
      pageSize,
      total: Number(counted?.total ?? 0),
    };
  }

  /** The frozen engine verdict on a posted document — never re-determined. */
  async frozenTaxLines(orgId: string, documentId: string) {
    const header = await loadHeader(orgId, documentId, this.db);
    return this.db
      .select({
        component: taxDocumentLines.component,
        jurisdiction: taxDocumentLines.jurisdiction,
        rateBp: taxDocumentLines.rateBp,
        taxableMinor: taxDocumentLines.taxableMinor,
        taxMinor: taxDocumentLines.taxMinor,
        currency: taxDocumentLines.currency,
        glRole: taxDocumentLines.glRole,
        glAccountId: taxDocumentLines.glAccountId,
        documentLineId: taxDocumentLines.documentLineId,
      })
      .from(taxDocumentLines)
      .where(
        and(
          eq(taxDocumentLines.orgId, orgId),
          eq(taxDocumentLines.bookId, header.bookId),
          eq(taxDocumentLines.documentId, documentId),
        ),
      );
  }

  /* ---------------------------------------------------------- draft write */

  async createInvoice(
    orgId: string,
    userId: string | null,
    input: CreateInvoiceInput,
  ): Promise<ArDocumentView> {
    return this.createDraft(orgId, userId, "INVOICE", input);
  }

  async createCreditNote(
    orgId: string,
    userId: string | null,
    input: CreateCreditNoteInput,
  ): Promise<ArDocumentView> {
    return this.createDraft(orgId, userId, "CREDIT_NOTE", input);
  }

  private async createDraft(
    orgId: string,
    userId: string | null,
    documentType: ArDocumentType,
    input: ArDraftInput,
  ): Promise<ArDocumentView> {
    const book = await this.books.requireDefault(orgId);
    assertIsoDate(input.issueDate);

    return this.db.transaction(async (tx) => {
      const createdId = await createDraftInTx(
        this.parties,
        orgId,
        userId,
        documentType,
        book,
        input,
        tx,
      );
      return this.get(orgId, createdId, tx);
    });
  }

  /**
   * Copy a posted invoice into a draft credit note.
   *
   * The correction path for a posted document is a new document, never an edit —
   * which is exactly why this exists as a first-class operation.
   */
  async creditNoteFromInvoice(
    orgId: string,
    userId: string | null,
    invoiceId: string,
    input: CreditNoteFromInvoiceInput = {},
  ): Promise<ArDocumentView> {
    const invoice = await this.get(orgId, invoiceId);
    if (invoice.documentType !== "INVOICE") {
      throw new BadRequestException("Only an invoice can be credited");
    }
    if (invoice.status === "DRAFT") {
      throw new ConflictException("Delete the draft instead of crediting it");
    }

    return this.createDraft(orgId, userId, "CREDIT_NOTE", creditNoteDraftFrom(invoice, input));
  }

  /** Drafts are mutable; a posted document is not. Editing one is a 409. */
  async updateDraft(
    orgId: string,
    documentId: string,
    patch: UpdateDraftInput,
  ): Promise<ArDocumentView> {
    return this.db.transaction(async (tx) => {
      const deps = { books: this.books, parties: this.parties };
      await updateDraftInTx(deps, orgId, documentId, patch, tx);
      return this.get(orgId, documentId, tx);
    });
  }

  async deleteDraft(orgId: string, documentId: string): Promise<{ id: string; deleted: true }> {
    return this.db.transaction(async (tx) => {
      const current = await lockDocument(orgId, documentId, tx);
      assertDraft(current);
      await tx
        .update(arDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));
      return { id: documentId, deleted: true as const };
    });
  }

  /* --------------------------------------------------------------- preview */

  /**
   * Run determination and show the answer without writing anything — no journal,
   * no frozen tax rows, no sequence consumed. This is what the invoice screen
   * calls on every keystroke.
   */
  async previewTax(orgId: string, documentId: string): Promise<TaxPreview> {
    const header = await loadHeader(orgId, documentId, this.db);
    const party = await this.parties.requireForBook(orgId, header.bookId, header.partyId);
    const lines = await loadComputedLines(documentId, this.db);
    if (lines.length === 0) throw new BadRequestException("A document needs at least one line");

    const determined = await this.tax.determine(
      header.bookId,
      await buildTaxContext(this.tax, header, party, lines, this.db),
      this.db,
    );

    return toPreview(header.currency, determined);
  }

  /* ------------------------------------------------------------- posting */

  /**
   * Compute, determine, number, freeze and post — all inside one transaction.
   *
   * Posting twice is safe from two directions at once: the row lock plus the
   * status check catch the sequential double-click, and the ledger's
   * `(book, idempotency_key)` unique catches the genuinely concurrent one. Both
   * callers get the same journal; there is never a second one.
   */
  async post(
    orgId: string,
    userId: string | null,
    documentId: string,
  ): Promise<{ document: ArDocumentView; journal: PostedJournal }> {
    return this.db.transaction(async (tx) =>
      postDocumentInTx(
        {
          books: this.books,
          ledger: this.ledger,
          sequences: this.sequences,
          packs: this.packs,
          tax: this.tax,
          parties: this.parties,
          compliance: this.compliance,
        },
        orgId,
        userId,
        documentId,
        tx,
      ),
    );
  }
}

