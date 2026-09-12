/**
 * Files hanging off an accounting document — the vendor's own PDF bill, a
 * signed contract behind an invoice, the bank advice behind a receipt
 * (`09-feature-backlog.md` §N, "Attachments on docs (R2)", v1).
 *
 * The bytes live in R2; this table holds the pointer and the metadata the list
 * screen needs, so listing a document's attachments never touches object
 * storage.
 *
 * `document_type` + `document_id` is deliberately **not** a foreign key, and it
 * is the one shape backend/CLAUDE.md §3 warns about. The alternative here is
 * seven nullable columns and a seven-way exclusive-arc CHECK across five
 * tables, re-edited every time accounting grows a document kind. What buys the
 * safety back is that the service resolves the target through the owning table
 * on **every** call — attach, list, download and delete — with `org_id` and
 * `book_id` asserted, so an attachment can never be created against, or read
 * through, a document the caller cannot already see. The composite tenant
 * uniques below keep the row itself joinable the way every other accounting
 * table is.
 */
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { glBooks } from "./gl-kernel";

/** The document kinds an attachment can hang off, as the ledger spells them. */
export const ATTACHABLE_DOCUMENT_TYPES = [
  "sales_invoice",
  "credit_note",
  "purchase_bill",
  "debit_note",
  "receipt",
  "payment",
  "journal",
] as const;

export type AttachableDocumentType = (typeof ATTACHABLE_DOCUMENT_TYPES)[number];

export const glDocumentAttachments = pgTable(
  "gl_document_attachments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => glBooks.id, { onDelete: "cascade" }),

    documentType: text("document_type").$type<AttachableDocumentType>().notNull(),
    documentId: text("document_id").notNull(),

    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),

    /** The R2 object key — the only handle that can fetch the bytes back. */
    storageKey: text("storage_key").notNull(),
    /**
     * Whatever the storage layer handed back for display. `accounting` is a
     * private folder root, so this is the key rather than a public URL: the
     * bytes are only reachable through the permission-gated download.
     */
    storageUrl: text("storage_url"),

    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /**
     * Soft delete. A posted document's attachments stay attached: removing one
     * clears it from the list and never touches the document or its journal.
     */
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    unique("uniq_gl_document_attachments_org_id").on(t.orgId, t.id),
    unique("uniq_gl_document_attachments_book_id").on(t.bookId, t.id),
    /** The list query: everything attached to one document, newest first. */
    index("idx_gl_document_attachments_document")
      .on(t.bookId, t.documentType, t.documentId)
      .where(sql`deleted_at IS NULL`),
    index("idx_gl_document_attachments_org_book").on(t.orgId, t.bookId),
    check(
      "ck_gl_document_attachments_type",
      sql`document_type IN ('sales_invoice','credit_note','purchase_bill','debit_note','receipt','payment','journal')`,
    ),
    check("ck_gl_document_attachments_size", sql`size_bytes > 0`),
  ],
);

export const glDocumentAttachmentsRelations = relations(glDocumentAttachments, ({ one }) => ({
  book: one(glBooks, {
    fields: [glDocumentAttachments.bookId],
    references: [glBooks.id],
  }),
}));

export type AcctDocumentAttachment = typeof glDocumentAttachments.$inferSelect;
