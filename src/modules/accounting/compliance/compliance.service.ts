import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  arDocuments,
  documentCompliance,
  glBooks,
  taxRegistrations,
  type ComplianceStatus,
  type ComplianceTransport,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../kernel/sequence.service";
import type {
  CompliancePayload,
  ComplianceTransportAdapter,
  TransportResult,
} from "./transport/compliance-transport.port";

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

  /**
   * Hand a document to whatever transport this deployment has, and record what
   * came back — the *only* route from `pending` to any success state.
   *
   * Written on a row of the adapter's own transport, which for a mock is
   * `mock_irp` (0673) and therefore a different row from the `irp` decision
   * that recorded the obligation. Both survive, and together they say the true
   * thing: the IRP wants this document, and a mock pretended to file it.
   * Collapsing them would lose one half or the other.
   *
   * Nothing here decides anything. It cannot report a filing that an adapter
   * did not return, and it cannot invent an acknowledgement, because both come
   * out of the `TransportResult` and neither is written from a literal.
   *
   * It also will not offer a document that is already registered — see
   * `acknowledgementOnFile`, which is why a second submit cannot produce a
   * second IRN.
   */
  async submitToTransport(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    adapter: ComplianceTransportAdapter,
    payload: CompliancePayload,
    tx: DbOrTx = this.db,
  ): Promise<TransportResult> {
    const filed = await this.acknowledgementOnFile(
      orgId,
      bookId,
      documentType,
      documentId,
      adapter.transport,
      tx,
    );
    if (filed) return filed;

    const result = await adapter.submit(payload);
    const now = new Date();

    const row = {
      orgId,
      bookId,
      documentType,
      documentId,
      transport: adapter.transport,
      enforcementAtPost: "off" as const,
      lastAttemptAt: now,
      ...this.columnsFor(result),
    };

    await tx
      .insert(documentCompliance)
      .values(row)
      .onConflictDoUpdate({
        target: [
          documentCompliance.bookId,
          documentCompliance.documentType,
          documentCompliance.documentId,
          documentCompliance.transport,
        ],
        /*
          A resubmission overwrites the previous attempt's outcome rather than
          accumulating rows. The unique index is on exactly this tuple, so the
          alternative is a conflict, not a history — and a history of attempts
          belongs in `attempt_count` and the audit log, not in duplicated
          evidence rows that a reader would have to rank.
        */
        set: this.columnsFor(result),
      });

    return result;
  }

  /**
   * The acknowledgement this document already holds from this transport, if any
   * — the fence that stops one invoice being registered twice.
   *
   * A second `POST .../submit` must never produce a second IRN. Three things
   * stand between it and one, and this is the durable one:
   *
   *  1. `@Idempotent` on the route replays the first response for a caller who
   *     retries with the same `Idempotency-Key` — but it fences a *request*, and
   *     a second deliberate submit is a different request.
   *  2. This: a row that already carries an authority's identifier is evidence
   *     that the document is registered, so no adapter is called at all. It
   *     survives a restart and a redeploy, which an in-memory fence would not.
   *  3. Failing both, the IRP derives an IRN from the seller's GSTIN, the
   *     document number and the financial year, and answers a resubmission with
   *     the registration it already made.
   *
   * Only an `accepted` row with an identifier counts. A `pending` row is an
   * obligation nobody has discharged, and a `rejected` one is a document the
   * authority refused — both must stay submittable, or a corrected invoice could
   * never be filed.
   */
  private async acknowledgementOnFile(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    transport: ComplianceTransport,
    tx: DbOrTx,
  ): Promise<TransportResult | null> {
    const [row] = await tx
      .select({
        status: documentCompliance.status,
        authorityId: documentCompliance.authorityId,
        ackNo: documentCompliance.ackNo,
        ackAt: documentCompliance.ackAt,
      })
      .from(documentCompliance)
      .where(
        and(
          eq(documentCompliance.orgId, orgId),
          eq(documentCompliance.bookId, bookId),
          eq(documentCompliance.documentType, documentType),
          eq(documentCompliance.documentId, documentId),
          eq(documentCompliance.transport, transport),
        ),
      )
      .limit(1);

    if (!row || row.status !== "accepted") return null;
    if (!row.authorityId || !row.ackNo || !row.ackAt) return null;

    /*
      Echoed from the row, not minted here. Every field came out of a
      `TransportResult` an adapter returned on the first submission, so this
      says exactly what was said then and nothing more.
    */
    return {
      outcome: "accepted",
      authorityId: row.authorityId,
      ackNo: row.ackNo,
      ackAt: row.ackAt,
    };
  }

  /**
   * The result, as columns. Split out so `submitToTransport`'s insert and its
   * conflict update cannot drift — two copies of this is how one of them stops
   * clearing `errors` on a retry that finally succeeded.
   */
  private columnsFor(result: TransportResult) {
    switch (result.outcome) {
      case "accepted":
        return {
          status: "accepted" as const,
          authorityId: result.authorityId,
          ackNo: result.ackNo,
          ackAt: result.ackAt,
          errors: null,
        };
      case "rejected":
        return {
          status: "rejected" as const,
          authorityId: null,
          ackNo: null,
          ackAt: null,
          errors: result.errors,
        };
      case "unavailable":
        /*
          Stays `pending`, not `rejected`. The authority never saw the document,
          so nothing about it has been judged; marking it rejected would tell
          somebody to correct an invoice that may be perfectly correct.
        */
        return {
          status: "pending" as const,
          authorityId: null,
          ackNo: null,
          ackAt: null,
          errors: [{ code: "TRANSPORT_UNAVAILABLE", message: result.reason }],
        };
    }
  }

  /**
   * The facts an authority is offered about an AR document.
   *
   * Read here, from the posted document, rather than accepted from the caller.
   * A `POST .../submit` that took totals in its body would let whoever calls it
   * send a tax authority a different figure from the one in the ledger, and the
   * discrepancy would surface as a notice months later with the product's own
   * submission as the evidence against the tenant.
   *
   * Returns null for a document type this cannot resolve — today, anything that
   * is not an AR document. The legacy `invoices` table has its own numbering
   * and its deprecation is the subject of `docs/adr-legacy-invoices-vs-ar.md`;
   * offering to file from it would deepen a dependency that is being retired.
   */
  async payloadForDocument(
    orgId: string,
    bookId: string,
    documentType: string,
    documentId: string,
    tx: DbOrTx = this.db,
  ): Promise<CompliancePayload | null> {
    const [doc] = await tx
      .select({
        documentNumber: arDocuments.documentNumber,
        issueDate: arDocuments.issueDate,
        currency: arDocuments.currency,
        grossMinor: arDocuments.grossMinor,
        partyId: arDocuments.partyId,
      })
      .from(arDocuments)
      .where(
        and(
          eq(arDocuments.orgId, orgId),
          eq(arDocuments.bookId, bookId),
          eq(arDocuments.id, documentId),
        ),
      )
      .limit(1);

    if (!doc) return null;

    const [seller] = await tx
      .select({ number: taxRegistrations.number })
      .from(taxRegistrations)
      .where(and(eq(taxRegistrations.bookId, bookId), eq(taxRegistrations.ownerType, "book")))
      .limit(1);

    const [buyer] = await tx
      .select({ number: taxRegistrations.number })
      .from(taxRegistrations)
      .where(
        and(eq(taxRegistrations.partyId, doc.partyId), eq(taxRegistrations.ownerType, "party")),
      )
      .limit(1);

    /*
      No seller registration means the document was never reportable in the
      first place — `decide` already returns `not_required` for it — so a
      submit reaching here without one is a caller bug, not something to paper
      over with an empty string.
    */
    if (!seller) return null;

    return {
      documentType,
      documentId,
      documentNumber: doc.documentNumber ?? documentId,
      documentDate: doc.issueDate,
      sellerTaxId: seller.number,
      buyerTaxId: buyer?.number ?? null,
      currency: doc.currency,
      totalMinor: doc.grossMinor,
    };
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
      )
      /*
        Ordered, because there is now more than one row per document: the
        decision is recorded against the transport that WANTS the document
        (`irp`) and a submission is recorded against the transport that HANDLED
        it (`mock_irp`). Callers that took `rows[0]` from an unordered query
        would read a different row run to run.
      */
      .orderBy(asc(documentCompliance.transport));
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
