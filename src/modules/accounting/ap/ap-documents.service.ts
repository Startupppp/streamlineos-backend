import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { apDocumentLines, apDocuments, taxDocumentLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { PackRegistry } from "../packs/pack.registry";
import { TaxService } from "../tax/tax.service";
import { requireVendor } from "./ap.vendor-lookup";
import type {
  ApDocumentDetail,
  ApDocumentSummary,
  ApPostResult,
  ApTaxPreview,
} from "./ap.types";
import type {
  CreateApDocumentInput,
  ListApDocumentsQuery,
  UpdateApDocumentInput,
} from "./dto/ap-documents.schemas";
import { draftPatch, draftValues, writeDraftLines } from "./lib/ap-document-drafts";
import {
  assertAccountsBelongToBook,
  assertDraft,
  assertFxIsCoherent,
  assertOriginalExists,
  guardDuplicateVendorNumber,
} from "./lib/ap-document-guards";
import { postDocument } from "./lib/ap-document-post";
import {
  getDocumentDetail,
  listDocuments,
  loadDocumentRow,
  loadDocumentRowForUpdate,
  loadLineRows,
} from "./lib/ap-document-reads";
import { computeTotals, toTaxPreview } from "./lib/ap-document-tax";

/**
 * Bills and debit notes.
 *
 * One table, discriminated by `document_type`, because a debit note is a signed
 * bill: two tables would mean two open-item calculations that could disagree.
 * A debit note posts the exact mirror of a bill — there is one journal builder
 * (`lib/ap-document-journal.ts`), with the sides flipped, rather than two that
 * drift apart.
 *
 * The service computes, asks `TaxService` what the tax is, and hands
 * `LedgerService` a balanced command. It never writes a journal line, never
 * hardcodes an account code, and never branches on a country. It owns the
 * transactions; the steps in `lib/` run on the one they are handed.
 */
@Injectable()
export class ApDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly tax: TaxService,
    private readonly packs: PackRegistry,
  ) {}

  /* --------------------------------------------------------------- reads */

  async get(orgId: string, documentId: string, tx: DbOrTx = this.db): Promise<ApDocumentDetail> {
    return getDocumentDetail(tx, orgId, documentId);
  }

  async list(
    orgId: string,
    query: ListApDocumentsQuery,
  ): Promise<{ items: ApDocumentSummary[]; page: number; pageSize: number; total: number }> {
    const book = await this.books.requireDefault(orgId);
    return listDocuments(this.db, orgId, book.id, query);
  }

  /* -------------------------------------------------------------- drafts */

  async create(
    orgId: string,
    userId: string | null,
    input: CreateApDocumentInput,
  ): Promise<ApDocumentDetail> {
    return this.db.transaction(async (tx) => {
      const book = input.bookId
        ? await this.books.get(orgId, input.bookId, tx)
        : await this.books.requireDefault(orgId, tx);
      const vendor = await requireVendor(tx, orgId, book.id, input.partyId);
      const currency = input.currency ?? book.baseCurrency;
      const fxRate = input.fxRate ?? "1";
      assertFxIsCoherent(currency, book.baseCurrency, fxRate);

      const issueDate = assertIsoDate(input.issueDate);
      await assertAccountsBelongToBook(tx, book.id, input.lines);
      if (input.originalDocumentId) {
        await assertOriginalExists(tx, orgId, book.id, input.originalDocumentId);
      }

      const values = draftValues(
        { orgId, bookId: book.id, vendorId: vendor.id, userId, currency, fxRate, issueDate },
        input,
      );

      const [created] = await guardDuplicateVendorNumber(
        vendor.displayName,
        input.vendorDocumentNumber ?? null,
        () => tx.insert(apDocuments).values(values).returning({ id: apDocuments.id }),
      );
      if (!created) throw new ConflictException("Could not create the document");

      await writeDraftLines(tx, orgId, created.id, input.lines);
      return this.get(orgId, created.id, tx);
    });
  }

  /**
   * Edit a draft. A posted document is immutable — the correction is a debit
   * note or a reversal, never an edit, so this is a 409 and not a 400.
   */
  async update(
    orgId: string,
    documentId: string,
    input: UpdateApDocumentInput,
  ): Promise<ApDocumentDetail> {
    return this.db.transaction(async (tx) => {
      const existing = await loadDocumentRowForUpdate(tx, orgId, documentId);
      assertDraft(existing);

      const book = await this.books.get(orgId, existing.bookId, tx);
      const partyId = input.partyId ?? existing.partyId;
      const vendor = await requireVendor(tx, orgId, book.id, partyId);

      const currency = input.currency ?? existing.currency;
      const fxRate = input.fxRate ?? existing.fxRate;
      assertFxIsCoherent(currency, book.baseCurrency, fxRate);
      if (input.lines) await assertAccountsBelongToBook(tx, book.id, input.lines);
      if (input.originalDocumentId) {
        await assertOriginalExists(tx, orgId, book.id, input.originalDocumentId);
      }

      const vendorDocumentNumber =
        input.vendorDocumentNumber === undefined
          ? existing.vendorDocumentNumber
          : (input.vendorDocumentNumber ?? null);

      await guardDuplicateVendorNumber(vendor.displayName, vendorDocumentNumber, () =>
        tx
          .update(apDocuments)
          .set(
            draftPatch(existing, input, {
              vendorId: vendor.id,
              vendorDocumentNumber,
              currency,
              fxRate,
            }),
          )
          .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)))
          .returning({ id: apDocuments.id }),
      );

      if (input.lines) {
        await tx.delete(apDocumentLines).where(eq(apDocumentLines.documentId, documentId));
        await writeDraftLines(tx, orgId, documentId, input.lines);
      }

      return this.get(orgId, documentId, tx);
    });
  }

  /** Soft delete, and only while it is a draft. Posted history never vanishes. */
  async remove(orgId: string, documentId: string): Promise<{ id: string; deleted: true }> {
    return this.db.transaction(async (tx) => {
      const existing = await loadDocumentRowForUpdate(tx, orgId, documentId);
      assertDraft(existing);
      await tx
        .update(apDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)));
      return { id: documentId, deleted: true as const };
    });
  }

  /* ---------------------------------------------------------- tax preview */

  /**
   * What the engine would say, with nothing written.
   *
   * Purchases run determination with `direction: 'purchase'`, which is what
   * makes the same 18% resolve to *input* CGST/SGST here and *output*
   * CGST/SGST on a sales invoice — the difference is one field, not a fork.
   */
  async previewTax(orgId: string, documentId: string): Promise<ApTaxPreview> {
    const doc = await loadDocumentRow(this.db, orgId, documentId);
    const lines = await loadLineRows(this.db, documentId);
    const book = await this.books.get(orgId, doc.bookId);
    const vendor = await requireVendor(this.db, orgId, doc.bookId, doc.partyId);

    const totals = await computeTotals(this.tax, this.db, doc, lines, vendor, book.countryCode);
    return toTaxPreview(documentId, doc.currency, totals);
  }

  /* -------------------------------------------------------------- posting */

  /**
   * Freeze the document and post its journal, in one transaction. Posting a
   * posted document replays its journal rather than writing a second one.
   * The flow, and why reverse charge needs no country branch, is documented
   * on `postDocument` in `lib/ap-document-post.ts`.
   */
  async post(orgId: string, userId: string | null, documentId: string): Promise<ApPostResult> {
    return this.db.transaction((tx) =>
      postDocument(
        {
          books: this.books,
          ledger: this.ledger,
          sequences: this.sequences,
          tax: this.tax,
          packs: this.packs,
        },
        tx,
        orgId,
        userId,
        documentId,
      ),
    );
  }

  /* ------------------------------------------------------------- frozen taxes */

  /** Returns tax lines frozen at posting time. */
  async frozenTaxLines(orgId: string, documentId: string) {
    return this.db.transaction(async (tx) => {
      const doc = await loadDocumentRow(tx, orgId, documentId);
      const lines = await tx
        .select()
        .from(taxDocumentLines)
        .where(
          and(
            eq(taxDocumentLines.orgId, orgId),
            eq(taxDocumentLines.bookId, doc.bookId),
            eq(taxDocumentLines.documentType, doc.documentType),
            eq(taxDocumentLines.documentId, documentId),
          )
        )
        .orderBy(taxDocumentLines.createdAt);
      return lines;
    });
  }
}
