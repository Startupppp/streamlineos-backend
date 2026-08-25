/**
 * E-invoicing and e-reporting hooks (PRD 13).
 *
 * v1 stores **fields and status only** — no government API is called. The point
 * is that when India IRP, Peppol, ViDA or FATOORA does arrive, it is a job that
 * fills these columns rather than a migration of every posted invoice.
 *
 * Posting never blocks on compliance while enforcement is `off`.
 */
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../common/auth";
import { glBooks } from "./gl-kernel";

export const complianceTransportEnum = pgEnum("compliance_transport", [
  "none",
  "irp",
  "peppol",
  "fatoora",
  "sdi",
  "mtd",
  "other",
]);

export const complianceStatusEnum = pgEnum("compliance_status", [
  "not_required",
  "pending",
  "submitted",
  "accepted",
  "rejected",
  "cancelled",
]);

/**
 * How hard a failure bites. v1 ships `off` everywhere: an invoice posts whether
 * or not the authority is reachable, because a founder losing the ability to
 * bill because a government endpoint is down is not an acceptable trade.
 */
export const complianceEnforcementEnum = pgEnum("compliance_enforcement", [
  "off",
  "warn",
  "block_send",
  "block_post",
]);

export const documentCompliance = pgTable(
  "gl_document_compliance",
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

    /** `sales_invoice`, `credit_note`, `debit_note`, `purchase_bill`. */
    documentType: text("document_type").notNull(),
    documentId: text("document_id").notNull(),

    transport: complianceTransportEnum("transport").notNull().default("none"),
    status: complianceStatusEnum("status").notNull().default("not_required"),
    enforcementAtPost: complianceEnforcementEnum("enforcement_at_post").notNull().default("off"),

    /** IRN, Peppol message id, FATOORA UUID — whatever the network calls it. */
    authorityId: text("authority_id"),
    ackNo: text("ack_no"),
    ackAt: timestamp("ack_at"),

    /** Payloads live in R2, not Postgres — they are large and signed. */
    payloadR2Key: text("payload_r2_key"),
    qrR2Key: text("qr_r2_key"),
    /** Schema version of the payload, so an IRP bump is survivable. */
    schemaVersion: text("schema_version"),

    errors: jsonb("errors").$type<Array<{ code: string; message: string }>>(),
    attemptCount: text("attempt_count"),
    lastAttemptAt: timestamp("last_attempt_at"),

    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_gl_document_compliance_org_id").on(t.orgId, t.id),
    /** One compliance record per document per transport (idempotent submit). */
    uniqueIndex("uniq_gl_document_compliance_document").on(
      t.bookId,
      t.documentType,
      t.documentId,
      t.transport,
    ),
    /** An accepted authority id is unique where the network demands it. */
    uniqueIndex("uniq_gl_document_compliance_authority")
      .on(t.transport, t.authorityId)
      .where(sql`authority_id IS NOT NULL`),
    index("idx_gl_document_compliance_book_status").on(t.bookId, t.status),
  ],
);

export const documentComplianceRelations = relations(documentCompliance, ({ one }) => ({
  book: one(glBooks, { fields: [documentCompliance.bookId], references: [glBooks.id] }),
}));

export type DocumentCompliance = typeof documentCompliance.$inferSelect;
export type ComplianceTransport = (typeof complianceTransportEnum.enumValues)[number];
export type ComplianceStatus = (typeof complianceStatusEnum.enumValues)[number];
