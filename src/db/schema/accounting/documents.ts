/**
 * Source documents — parties, AR (invoices, credit notes, receipts) and AP
 * (bills, debit notes, payments, withholding).
 *
 * Documents are **sources**: they compute, they freeze tax, and they emit a
 * `PostJournal`. They never write a journal line themselves.
 *
 * Invoices and credit notes share one table discriminated by `document_type`,
 * as do bills and debit notes. Their columns are identical and a credit note is
 * a signed invoice; two tables would mean two open-item calculations that could
 * disagree. This is a discriminated table with real foreign keys, not the
 * `entity_type`/`entity_id` polymorphism backend/CLAUDE.md §3 bans.
 *
 * The tables live beside this file and are re-exported from it, so every name
 * it ever exported still is:
 *
 *   documents-parties.ts          enums, and `gl_parties`
 *   documents-ar.ts               `ar_documents`, `ar_document_lines`
 *   documents-ar-settlements.ts   `ar_receipts`, `ar_allocations`
 *   documents-ap.ts               `ap_documents`, `ap_document_lines`
 *   documents-ap-settlements.ts   `ap_payments`, `ap_allocations`, `ap_withholding`
 */
import { relations } from "drizzle-orm";
import { glBooks } from "./gl-kernel";
import { glParties } from "./documents-parties";
import { arDocuments } from "./documents-ar";
import { apDocuments } from "./documents-ap";

export * from "./documents-parties";
export * from "./documents-ar";
export * from "./documents-ar-settlements";
export * from "./documents-ap";
export * from "./documents-ap-settlements";

/* --------------------------------------------------------------- relations */

/* Declared here because it names both document tables, which import the parties file. */
export const glPartiesRelations = relations(glParties, ({ one, many }) => ({
  book: one(glBooks, { fields: [glParties.bookId], references: [glBooks.id] }),
  arDocuments: many(arDocuments),
  apDocuments: many(apDocuments),
}));
