import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { apAllocations, apPayments, apWithholding } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { PackRegistry } from "../packs/pack.registry";
import { TaxService } from "../tax/tax.service";
import { WithholdingEngineRegistry } from "./withholding/withholding.registry";
import type { ApPaymentDto, ApPaymentPostResult } from "./ap.types";
import type {
  AllocateDebitNoteInput,
  AllocatePaymentInput,
  ListApPaymentsQuery,
  PostApPaymentInput,
  ReversePaymentInput,
} from "./dto/ap-payments.schemas";
import { postVendorPayment } from "./lib/ap-payment-post";
import { getPayment, listPayments, loadPaymentForUpdate } from "./lib/ap-payment-reads";
import {
  OPEN_STATUSES,
  applySettlement,
  loadAllocationTargets,
  loadDocumentForUpdate,
  writeAllocation,
} from "./lib/ap-settlement";

/**
 * Vendor payments, allocations and withholding.
 *
 * A payment moves three things at once and the schema keeps all three, so a
 * challan can be reconciled later without recomputing anything:
 *
 *   Dr accounts payable   gross      what the vendor was owed
 *   Cr withholding payable  withheld  tax retained on their behalf
 *   Cr bank or cash          net      what actually left the account
 *
 * When nothing is withheld the middle line simply is not emitted and this
 * collapses to Dr AP / Cr bank. The bill is cleared by the **gross** either
 * way — the vendor's debt is discharged by the tax being remitted for them.
 *
 * This class owns the transactions. Posting, withholding, settlement and the
 * reads live in `lib/` and run on the transaction they are handed.
 */
@Injectable()
export class ApPaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly tax: TaxService,
    private readonly packs: PackRegistry,
    private readonly withholdingEngines: WithholdingEngineRegistry,
  ) {}

  /* --------------------------------------------------------------- reads */

  async get(orgId: string, paymentId: string, tx: DbOrTx = this.db): Promise<ApPaymentDto> {
    return getPayment(tx, orgId, paymentId);
  }

  async list(
    orgId: string,
    query: ListApPaymentsQuery,
  ): Promise<{ items: ApPaymentDto[]; page: number; pageSize: number; total: number }> {
    const book = await this.books.requireDefault(orgId);
    return listPayments(this.db, orgId, book.id, query);
  }

  /* ------------------------------------------------------------- posting */

  async postPayment(
    orgId: string,
    userId: string | null,
    input: PostApPaymentInput,
  ): Promise<ApPaymentPostResult> {
    return this.db.transaction((tx) =>
      postVendorPayment(
        {
          books: this.books,
          ledger: this.ledger,
          sequences: this.sequences,
          tax: this.tax,
          packs: this.packs,
          withholdingEngines: this.withholdingEngines,
        },
        tx,
        orgId,
        userId,
        input,
      ),
    );
  }

  /* --------------------------------------------------------- allocations */

  /** Apply an already-posted payment's unapplied balance to more bills. */
  async allocate(
    orgId: string,
    userId: string | null,
    paymentId: string,
    input: AllocatePaymentInput,
  ): Promise<ApPaymentDto> {
    return this.db.transaction(async (tx) => {
      const payment = await loadPaymentForUpdate(tx, orgId, paymentId);
      if (payment.status !== "POSTED") {
        throw new ConflictException("A reversed payment cannot be allocated");
      }

      const total = input.allocations.reduce((a, l) => a + l.amountMinor, 0);
      if (total > payment.unappliedMinor) {
        throw new BadRequestException(
          `This payment has only ${payment.unappliedMinor} unapplied; ${total} was requested`,
        );
      }

      await loadAllocationTargets(
        tx,
        orgId,
        payment.bookId,
        payment.partyId,
        payment.currency,
        input.allocations,
      );

      for (const allocation of input.allocations) {
        await writeAllocation(tx, {
          orgId,
          bookId: payment.bookId,
          paymentId,
          debitNoteId: null,
          documentId: allocation.documentId,
          amountMinor: allocation.amountMinor,
          userId,
        });
        await applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
      }

      await tx
        .update(apPayments)
        .set({ unappliedMinor: payment.unappliedMinor - total })
        .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)));

      return this.get(orgId, paymentId, tx);
    });
  }

  /**
   * Apply a posted debit note to bills.
   *
   * No journal: both documents already moved AP control when they posted — the
   * bill credited it, the debit note debited it. Allocating is bookkeeping
   * between two open items, so posting anything here would double-count.
   */
  async allocateDebitNote(
    orgId: string,
    userId: string | null,
    debitNoteId: string,
    input: AllocateDebitNoteInput,
  ): Promise<{ debitNoteId: string; appliedMinor: number; remainingMinor: number }> {
    return this.db.transaction(async (tx) => {
      const note = await loadDocumentForUpdate(tx, orgId, debitNoteId);
      if (note.documentType !== "DEBIT_NOTE") {
        throw new BadRequestException("That document is not a debit note");
      }
      if (!OPEN_STATUSES.includes(note.status)) {
        throw new ConflictException(`A ${note.status} debit note cannot be applied`);
      }

      const total = input.allocations.reduce((a, l) => a + l.amountMinor, 0);
      const available = note.grossMinor - note.settledMinor;
      if (total > available) {
        throw new BadRequestException(
          `This debit note has only ${available} left to apply; ${total} was requested`,
        );
      }

      await loadAllocationTargets(
        tx,
        orgId,
        note.bookId,
        note.partyId,
        note.currency,
        input.allocations,
      );

      for (const allocation of input.allocations) {
        if (allocation.documentId === debitNoteId) {
          throw new BadRequestException("A debit note cannot be applied to itself");
        }
        await writeAllocation(tx, {
          orgId,
          bookId: note.bookId,
          paymentId: null,
          debitNoteId,
          documentId: allocation.documentId,
          amountMinor: allocation.amountMinor,
          userId,
        });
        await applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
      }

      await applySettlement(tx, orgId, debitNoteId, total);

      return {
        debitNoteId,
        appliedMinor: total,
        remainingMinor: available - total,
      };
    });
  }

  /* ----------------------------------------------------------- reversing */

  /**
   * Reverse the journal, unwind every allocation, and drop the withholding.
   *
   * The withholding rows go because a reversed deduction was never made — a TDS
   * return for the period must not pick it up. The payment row itself stays,
   * marked `REVERSED`, carrying both journal ids: history is never rewritten.
   */
  async reversePayment(
    orgId: string,
    userId: string | null,
    paymentId: string,
    input: ReversePaymentInput = {},
  ): Promise<ApPaymentDto> {
    return this.db.transaction(async (tx) => {
      const payment = await loadPaymentForUpdate(tx, orgId, paymentId);
      if (payment.status === "REVERSED") return this.get(orgId, paymentId, tx);
      if (!payment.postedJournalId) {
        throw new ConflictException("This payment has no journal to reverse");
      }

      const reversal = await this.ledger.reverse(
        orgId,
        userId,
        {
          bookId: payment.bookId,
          journalId: payment.postedJournalId,
          journalDate: input.reversalDate ? assertIsoDate(input.reversalDate) : payment.paymentDate,
          idempotencyKey: `payment:${paymentId}:reverse`,
          memo: input.reason ?? `Reversal of payment ${payment.paymentNumber ?? paymentId}`,
        },
        tx,
      );

      const allocations = await tx
        .select({
          id: apAllocations.id,
          documentId: apAllocations.documentId,
          amountMinor: apAllocations.amountMinor,
        })
        .from(apAllocations)
        .where(and(eq(apAllocations.orgId, orgId), eq(apAllocations.paymentId, paymentId)));

      for (const allocation of allocations) {
        await applySettlement(tx, orgId, allocation.documentId, -allocation.amountMinor);
      }
      // Link rows, so a physical delete is right — there is nothing to retain
      // that the reversed journal and the REVERSED payment do not already say.
      await tx
        .delete(apAllocations)
        .where(and(eq(apAllocations.orgId, orgId), eq(apAllocations.paymentId, paymentId)));
      await tx
        .delete(apWithholding)
        .where(and(eq(apWithholding.orgId, orgId), eq(apWithholding.paymentId, paymentId)));

      await tx
        .update(apPayments)
        .set({ status: "REVERSED", reversalJournalId: reversal.id, unappliedMinor: 0 })
        .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)));

      return this.get(orgId, paymentId, tx);
    });
  }
}
