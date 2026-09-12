/**
 * Writing AR drafts: inserting a new one, and applying an edit to one. Both run
 * on the caller's transaction and leave reading the document back to it.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { arDocuments, type ArDocumentType } from "../../../../db/schema";
import type { BookSummary, BooksService } from "../../kernel/books.service";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { PartiesService } from "../../parties/parties.service";
import type { UpdateDraftInput } from "../dto/ar-documents.schemas";
import { draftPatch, newDraftValues, type ArDraftInput } from "./ar-document-draft-values";
import { assertDraft, loadHeader, lockDocument } from "./ar-document-header";
import { refreshDraftTotals, replaceLines } from "./ar-document-lines";
import { resolveFxRate } from "./ar-document-lookups";

/** Insert a draft and its lines, and return the new document's id. */
export async function createDraftInTx(
  parties: PartiesService,
  orgId: string,
  userId: string | null,
  documentType: ArDocumentType,
  book: BookSummary,
  input: ArDraftInput,
  tx: DbOrTx,
): Promise<string> {
  const party = await parties.requireForBook(orgId, book.id, input.partyId, tx);
  const currency = (input.currency ?? party.defaultCurrency).toUpperCase();
  const fxRate = await resolveFxRate(
    book.id,
    book.baseCurrency,
    currency,
    input.issueDate,
    input.fxRate,
    tx,
  );

  if (documentType === "CREDIT_NOTE" && input.originalDocumentId) {
    const original = await loadHeader(orgId, input.originalDocumentId, tx);
    if (original.documentType !== "INVOICE") {
      throw new BadRequestException("A credit note can only reference an invoice");
    }
  }

  const [created] = await tx
    .insert(arDocuments)
    .values(newDraftValues({ orgId, userId, documentType, book, party, input, currency, fxRate }))
    .returning({ id: arDocuments.id });

  if (!created) throw new ConflictException("Could not create the document");

  await replaceLines(orgId, created.id, input.lines, tx);
  await refreshDraftTotals(created.id, tx);
  return created.id;
}

/** Lock a draft, apply the edit, and bring its lines and totals back in step. */
export async function updateDraftInTx(
  deps: { books: BooksService; parties: PartiesService },
  orgId: string,
  documentId: string,
  patch: UpdateDraftInput,
  tx: DbOrTx,
): Promise<void> {
  const current = await lockDocument(orgId, documentId, tx);
  assertDraft(current);

  const book = await deps.books.get(orgId, current.bookId, tx);
  const partyId = patch.partyId ?? current.partyId;
  const party = await deps.parties.requireForBook(orgId, current.bookId, partyId, tx);
  const issueDate = patch.issueDate ?? current.issueDate;
  const currency = (patch.currency ?? current.currency).toUpperCase();
  // Only re-snapshot the rate when the caller changed something that bears on
  // it — silently re-resolving on an unrelated edit would move a rate the
  // caller had pinned by hand.
  const fxRate =
    patch.fxRate !== undefined || currency !== current.currency
      ? await resolveFxRate(
          current.bookId,
          book.baseCurrency,
          currency,
          issueDate,
          patch.fxRate,
          tx,
        )
      : current.fxRate;

  await tx
    .update(arDocuments)
    .set(draftPatch({ current, patch, book, party, partyId, issueDate, currency, fxRate }))
    .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));

  if (patch.lines) await replaceLines(orgId, documentId, patch.lines, tx);
  await refreshDraftTotals(documentId, tx);
}
