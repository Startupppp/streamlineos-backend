import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  glDocumentAttachments,
  apDocuments,
  apPayments,
  arDocuments,
  arReceipts,
  glJournals,
  type AttachableDocumentType,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import type { DbOrTx } from "../kernel/sequence.service";
import {
  MAX_ATTACHMENT_BYTES,
  type AttachDocumentFileInput,
  type ListAttachmentsQuery,
} from "./dto/attachments.schemas";

export interface AttachmentView {
  id: string;
  bookId: string;
  documentType: AttachableDocumentType;
  documentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageUrl: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

export interface AttachmentPage {
  items: AttachmentView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AttachmentContent {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Files attached to accounting documents — the vendor's own PDF bill, the
 * signed contract behind an invoice (`09-feature-backlog.md` §N, v1).
 *
 * Two invariants:
 *
 * 1. **The target document is resolved on every call.** `document_type` +
 *    `document_id` carries no foreign key, so the referential check is this
 *    service's job and it runs on attach, list, download and delete alike —
 *    with `org_id` asserted, so another tenant's document is a 404 and never a
 *    403 (backend/CLAUDE.md §4).
 * 2. **Deleting an attachment never touches the document.** It is a soft
 *    delete: a posted document's evidence stays attached to its history, and
 *    the object is deliberately left in the bucket so an audit can still be
 *    answered.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async list(
    orgId: string,
    documentType: AttachableDocumentType,
    documentId: string,
    query: ListAttachmentsQuery = {},
  ): Promise<AttachmentPage> {
    const { bookId } = await this.requireDocument(orgId, documentType, documentId);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const where = and(
      eq(glDocumentAttachments.orgId, orgId),
      eq(glDocumentAttachments.bookId, bookId),
      eq(glDocumentAttachments.documentType, documentType),
      eq(glDocumentAttachments.documentId, documentId),
      isNull(glDocumentAttachments.deletedAt),
    );

    const [items, [counted]] = await Promise.all([
      this.db
        .select(VIEW_COLUMNS)
        .from(glDocumentAttachments)
        .where(where)
        .orderBy(desc(glDocumentAttachments.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ total: sql<string>`count(*)` })
        .from(glDocumentAttachments)
        .where(where),
    ]);

    return { items, page, pageSize, total: Number(counted?.total ?? 0) };
  }

  /** Metadata only — no bucket round trip. */
  async get(orgId: string, attachmentId: string): Promise<AttachmentView> {
    const row = await this.loadAttachment(orgId, attachmentId);
    return toView(row);
  }

  async download(orgId: string, attachmentId: string): Promise<AttachmentContent> {
    const row = await this.loadAttachment(orgId, attachmentId);
    // Re-resolve the document: an attachment is only readable through a
    // document the caller can still reach.
    await this.requireDocument(orgId, row.documentType, row.documentId);

    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException("File storage is not configured");
    }

    const stream = await this.storage.getFileStream(orgId, row.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }

    return {
      fileName: row.fileName,
      mimeType: row.mimeType,
      buffer: Buffer.concat(chunks),
    };
  }

  /* ---------------------------------------------------------------- write */

  async attach(
    orgId: string,
    userId: string | null,
    documentType: AttachableDocumentType,
    documentId: string,
    input: AttachDocumentFileInput,
  ): Promise<AttachmentView> {
    const { bookId } = await this.requireDocument(orgId, documentType, documentId);
    const buffer = decodeBase64(input.contentBase64);

    if (buffer.length === 0) throw new BadRequestException("The file is empty");
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        `The file is ${buffer.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    // The declared type has to match what the bytes actually are, or a script
    // arrives labelled as a PDF.
    if (!validateMagicBytes(buffer, input.mimeType)) {
      throw new BadRequestException(
        `The file contents are not a valid ${input.mimeType}`,
      );
    }

    if (!this.storage.isConfigured()) {
      // Unlike the rendered invoice PDF, there is nothing to fall back on: the
      // bytes only exist in this request and must not be silently dropped.
      throw new ServiceUnavailableException("File storage is not configured");
    }

    const uploaded = await this.storage.uploadFile(
      orgId,
      buffer,
      `accounting/${bookId}/attachments/${documentType}`,
      input.fileName,
      input.mimeType,
    );

    const [created] = await this.db
      .insert(glDocumentAttachments)
      .values({
        orgId,
        bookId,
        documentType,
        documentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: buffer.length,
        storageKey: uploaded.key,
        storageUrl: uploaded.url,
        uploadedBy: userId,
      })
      .returning(VIEW_COLUMNS);

    return toView(created);
  }

  /**
   * Soft delete. The document is untouched — a posted invoice keeps its journal,
   * its number and its history whatever happens to a file hanging off it.
   */
  async remove(orgId: string, attachmentId: string): Promise<{ id: string; deleted: true }> {
    const row = await this.loadAttachment(orgId, attachmentId);
    await this.requireDocument(orgId, row.documentType, row.documentId);

    await this.db
      .update(glDocumentAttachments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(glDocumentAttachments.orgId, orgId),
          eq(glDocumentAttachments.id, attachmentId),
          isNull(glDocumentAttachments.deletedAt),
        ),
      );

    return { id: attachmentId, deleted: true };
  }

  /* -------------------------------------------------------------- lookups */

  private async loadAttachment(orgId: string, attachmentId: string, tx: DbOrTx = this.db) {
    const [row] = await tx
      .select({ ...VIEW_COLUMNS, storageKey: glDocumentAttachments.storageKey })
      .from(glDocumentAttachments)
      .where(
        and(
          eq(glDocumentAttachments.orgId, orgId),
          eq(glDocumentAttachments.id, attachmentId),
          isNull(glDocumentAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Attachment not found");
    return row;
  }

  /**
   * Prove the document exists, belongs to this organisation, and is the kind
   * the caller named — then hand back its book so the attachment inherits the
   * same tenancy the document has.
   */
  private async requireDocument(
    orgId: string,
    documentType: AttachableDocumentType,
    documentId: string,
  ): Promise<{ bookId: string }> {
    switch (documentType) {
      case "sales_invoice":
      case "credit_note":
        return this.requireArDocument(
          orgId,
          documentId,
          documentType === "sales_invoice" ? "INVOICE" : "CREDIT_NOTE",
        );
      case "purchase_bill":
      case "debit_note":
        return this.requireApDocument(
          orgId,
          documentId,
          documentType === "purchase_bill" ? "BILL" : "DEBIT_NOTE",
        );
      case "receipt":
        return this.requireRow(
          this.db
            .select({ bookId: arReceipts.bookId })
            .from(arReceipts)
            .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, documentId)))
            .limit(1),
        );
      case "payment":
        return this.requireRow(
          this.db
            .select({ bookId: apPayments.bookId })
            .from(apPayments)
            .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, documentId)))
            .limit(1),
        );
      case "journal":
        // A read, never a write: only `LedgerService` writes the ledger.
        return this.requireRow(
          this.db
            .select({ bookId: glJournals.bookId })
            .from(glJournals)
            .where(and(eq(glJournals.orgId, orgId), eq(glJournals.id, documentId)))
            .limit(1),
        );
    }
  }

  private requireArDocument(orgId: string, documentId: string, type: "INVOICE" | "CREDIT_NOTE") {
    return this.requireRow(
      this.db
        .select({ bookId: arDocuments.bookId })
        .from(arDocuments)
        .where(
          and(
            eq(arDocuments.orgId, orgId),
            eq(arDocuments.id, documentId),
            eq(arDocuments.documentType, type),
            isNull(arDocuments.deletedAt),
          ),
        )
        .limit(1),
    );
  }

  private requireApDocument(orgId: string, documentId: string, type: "BILL" | "DEBIT_NOTE") {
    return this.requireRow(
      this.db
        .select({ bookId: apDocuments.bookId })
        .from(apDocuments)
        .where(
          and(
            eq(apDocuments.orgId, orgId),
            eq(apDocuments.id, documentId),
            eq(apDocuments.documentType, type),
            isNull(apDocuments.deletedAt),
          ),
        )
        .limit(1),
    );
  }

  private async requireRow(
    query: PromiseLike<Array<{ bookId: string }>>,
  ): Promise<{ bookId: string }> {
    const [row] = await query;
    if (!row) throw new NotFoundException("Document not found");
    return { bookId: row.bookId };
  }
}

/* -------------------------------------------------------------- helpers */

const VIEW_COLUMNS = {
  id: glDocumentAttachments.id,
  bookId: glDocumentAttachments.bookId,
  documentType: glDocumentAttachments.documentType,
  documentId: glDocumentAttachments.documentId,
  fileName: glDocumentAttachments.fileName,
  mimeType: glDocumentAttachments.mimeType,
  sizeBytes: glDocumentAttachments.sizeBytes,
  storageUrl: glDocumentAttachments.storageUrl,
  uploadedBy: glDocumentAttachments.uploadedBy,
  createdAt: glDocumentAttachments.createdAt,
};

function toView(row: AttachmentView): AttachmentView {
  return {
    id: row.id,
    bookId: row.bookId,
    documentType: row.documentType,
    documentId: row.documentId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageUrl: row.storageUrl,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

/**
 * Base64 in, bytes out. `Buffer.from(..., "base64")` silently ignores garbage,
 * so the round trip is checked rather than trusted — a truncated upload should
 * be a 400, not a corrupt file in the bucket.
 */
function decodeBase64(value: string): Buffer {
  const payload = value.includes(",") && value.trimStart().startsWith("data:")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  const cleaned = payload.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new BadRequestException("contentBase64 is not valid base64");
  }
  return Buffer.from(cleaned, "base64");
}
