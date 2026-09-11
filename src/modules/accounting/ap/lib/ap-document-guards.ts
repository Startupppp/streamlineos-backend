import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { apDocuments, glAccounts, type DocumentStatus } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import { isUniqueViolation } from "../ap.pg-errors";
import type { ApDocumentLineInput } from "../dto/ap-documents.schemas";

/**
 * The refusals a draft bill or debit note can meet before it is written: an
 * edit to a posted document, an incoherent FX rate, a vendor number entered
 * twice, an account from another book, or a debit note against no bill.
 */

export function assertDraft(doc: { status: DocumentStatus }): void {
  if (doc.status !== "DRAFT") {
    throw new ConflictException(
      "A posted document is immutable. Raise a debit note or reverse it instead of editing it.",
    );
  }
}

export function assertFxIsCoherent(currency: string, baseCurrency: string, fxRate: string): void {
  if (currency === baseCurrency && Number(fxRate) !== 1) {
    throw new BadRequestException(`A ${baseCurrency} document must carry an FX rate of 1`);
  }
  if (!(Number(fxRate) > 0)) {
    throw new BadRequestException("The FX rate must be greater than zero");
  }
}

/**
 * The vendor's own number is unique per vendor per book, enforced by
 * `uniq_ap_documents_vendor_number`. Postgres raises 23505; letting that
 * escape would be a 500 for what is a perfectly ordinary user mistake, so it
 * becomes a 409 that names the number (PRD 03 M3).
 */
export async function guardDuplicateVendorNumber<T>(
  vendorName: string,
  vendorDocumentNumber: string | null,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    // A machine-readable `code` alongside the sentence, so a client can
    // branch on the cause instead of pattern-matching the message text —
    // which is what the frontend was otherwise forced to do.
    if (isUniqueViolation(error, "uniq_ap_documents_vendor_number")) {
      throw new ConflictException({
        code: "DUPLICATE_VENDOR_DOCUMENT_NUMBER",
        message:
          `${vendorName} has already been entered with document number ` +
          `${vendorDocumentNumber ?? ""}. Open the existing bill instead of entering it twice.`,
        vendorDocumentNumber,
      });
    }
    if (isUniqueViolation(error, "uniq_ap_documents_book_number")) {
      throw new ConflictException({
        code: "DUPLICATE_DOCUMENT_NUMBER",
        message: "That document number is already in use in this book",
      });
    }
    throw error;
  }
}

export async function assertAccountsBelongToBook(
  tx: DbOrTx,
  bookId: string,
  lines: readonly ApDocumentLineInput[],
): Promise<void> {
  const wanted = [
    ...new Set(lines.map((l) => l.expenseAccountId).filter((id): id is string => Boolean(id))),
  ];
  if (wanted.length === 0) return;
  const rows = await tx
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.bookId, bookId),
        inArray(glAccounts.id, wanted),
        eq(glAccounts.isActive, true),
        eq(glAccounts.isHeader, false),
        isNull(glAccounts.deletedAt),
      ),
    );
  if (rows.length !== wanted.length) {
    throw new NotFoundException("One of the expense accounts does not exist in this book");
  }
}

export async function assertOriginalExists(
  tx: DbOrTx,
  orgId: string,
  bookId: string,
  originalDocumentId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: apDocuments.id })
    .from(apDocuments)
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.bookId, bookId),
        eq(apDocuments.id, originalDocumentId),
        ne(apDocuments.documentType, "DEBIT_NOTE"),
        isNull(apDocuments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("The original bill was not found");
}
