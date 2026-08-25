import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  documentCompliance,
  glBooks,
  taxRegistrations,
  type ComplianceStatus,
  type ComplianceTransport,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";

export interface ComplianceDecision {
  transport: ComplianceTransport;
  status: ComplianceStatus;
  reason: string;
}

/**
 * E-invoicing and e-reporting state (PRD 13).
 *
 * v1 decides *whether* a document would need to go somewhere and records that.
 * It calls nothing. The rule lives in the pack, not in AR, so adding Peppol
 * later is a new branch here rather than a change to how invoices post.
 *
 * Posting never blocks on this while enforcement is `off`, which is every book
 * in v1 — a founder losing the ability to invoice because a government endpoint
 * is down is not a trade worth making.
 */
@Injectable()
export class ComplianceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Decide the transport and initial status for a document at post time.
   *
   * India: B2B and export documents from a registered seller are the ones the
   * IRP would want. B2C generally is not reported. Everything else is
   * `not_required` until a real pack says otherwise.
   */
  async decide(
    bookId: string,
    input: {
      documentType: string;
      supplyNature: string;
      sellerHasTaxId: boolean;
      buyerHasTaxId: boolean;
    },
    tx: DbOrTx = this.db,
  ): Promise<ComplianceDecision> {
    const [book] = await tx
      .select({ localizationPack: glBooks.localizationPack })
      .from(glBooks)
      .where(eq(glBooks.id, bookId))
      .limit(1);

    if (!book) {
      return { transport: "none", status: "not_required", reason: "No book" };
    }

    if (book.localizationPack !== "IN") {
      return {
        transport: "none",
        status: "not_required",
        reason: `Pack ${book.localizationPack} has no e-reporting mandate wired up`,
      };
    }

    if (!input.sellerHasTaxId) {
      return {
        transport: "none",
        status: "not_required",
        reason: "Seller is not GST registered",
      };
    }

    const reportable =
      input.supplyNature === "domestic_b2b" ||
      input.supplyNature === "export" ||
      input.supplyNature === "reverse_charge";

    if (!reportable) {
      return {
        transport: "none",
        status: "not_required",
        reason: "B2C supplies are not reported to the IRP",
      };
    }

    // Marked pending, never submitted — the connector is PRD 13's later phase.
    return {
      transport: "irp",
      status: "pending",
      reason: "Awaiting IRN. No submission is attempted in this release.",
    };
  }

  /**
   * Record the decision against a posted document. Idempotent on
   * `(book, documentType, documentId, transport)`.
   */
  async record(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    decision: ComplianceDecision,
    tx: DbOrTx = this.db,
  ): Promise<void> {
    await tx
      .insert(documentCompliance)
      .values({
        orgId,
        bookId,
        documentType,
        documentId,
        transport: decision.transport,
        status: decision.status,
        enforcementAtPost: "off",
      })
      .onConflictDoNothing();
  }

  /** Decide and record in one step — what a document's post path calls. */
  async recordForDocument(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    input: {
      supplyNature: string;
      sellerHasTaxId: boolean;
      buyerHasTaxId: boolean;
    },
    tx: DbOrTx = this.db,
  ): Promise<ComplianceDecision> {
    const decision = await this.decide(bookId, { documentType, ...input }, tx);
    await this.record(orgId, bookId, documentType, documentId, decision, tx);
    return decision;
  }

  async get(orgId: string, bookId: string, documentType: string, documentId: string) {
    return this.db
      .select({
        transport: documentCompliance.transport,
        status: documentCompliance.status,
        authorityId: documentCompliance.authorityId,
        ackNo: documentCompliance.ackNo,
        ackAt: documentCompliance.ackAt,
        errors: documentCompliance.errors,
        cancelledAt: documentCompliance.cancelledAt,
      })
      .from(documentCompliance)
      .where(
        and(
          eq(documentCompliance.orgId, orgId),
          eq(documentCompliance.bookId, bookId),
          eq(documentCompliance.documentType, documentType),
          eq(documentCompliance.documentId, documentId),
        ),
      );
  }

  /** Does this book carry a tax identity the engine and IRP would recognise? */
  async bookHasTaxRegistration(bookId: string, tx: DbOrTx = this.db): Promise<boolean> {
    const [row] = await tx
      .select({ id: taxRegistrations.id })
      .from(taxRegistrations)
      .where(and(eq(taxRegistrations.bookId, bookId), eq(taxRegistrations.ownerType, "book")))
      .limit(1);
    return Boolean(row);
  }
}
