import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invoices, payments, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { DbOrTx } from "../accounting/kernel/sequence.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import {
  compareDecimals,
  decimalFromNumber,
  formatDecimal,
  roundDecimal,
  subtractDecimals,
  toDecimal,
} from "../accounting/core/money.util";
import type { RecordPaymentInput } from "./dto/invoice-write.schemas";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../common/logger/side-effect";

/**
 * `payments.amount` is `numeric(12,2)`, so a receipt can only ever be recorded to
 * the paisa. Pinning the request amount to that scale once — and comparing the
 * outstanding balance at the same scale — is what keeps the payment register and
 * the journal recording one quantity instead of two.
 */
export const PAYMENT_SCALE = 2;

function sumOfPayments() {
  return sql<string>`COALESCE(sum(${payments.amount}), 0)::text`;
}

function maxPayable(invoiceTotal: string | null, totalPaid: string | null | undefined): string {
  const remaining = subtractDecimals(toDecimal(invoiceTotal), toDecimal(totalPaid));
  return roundDecimal(remaining, PAYMENT_SCALE);
}

@Injectable()
export class InvoicesPaymentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: InvoicesPostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly lifecycle: InvoicesLifecycleService,
    private readonly audit: AuditService,
  ) {}

  private async createPayment(
    orgId: string,
    invoiceId: number,
    data: RecordPaymentInput & { createdBy: string; settledAmount: string },
    tx: DbOrTx,
  ) {
    const [payment] = await tx
      .insert(payments)
      .values({
        orgId,
        invoiceId,
        amount: data.settledAmount,
        paymentDate: data.paymentDate,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber ?? null,
        notes: data.notes ?? null,
        createdBy: data.createdBy,
      })
      .returning();

    await this.lifecycle.recomputeInvoiceBalance(invoiceId, tx);

    return payment;
  }

  async recordPayment(
    orgId: string,
    userId: string,
    invoiceId: number,
    input: RecordPaymentInput,
  ) {
    const invoice = await this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === "VOIDED") {
      throw new BadRequestException("Cannot record payment on voided invoice");
    }

    const settledAmount = roundDecimal(decimalFromNumber(input.amount), PAYMENT_SCALE);

    const [paidRow] = await this.db
      .select({ totalPaid: sumOfPayments() })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.orgId, orgId)));
    const payable = maxPayable(invoice.total, paidRow?.totalPaid);
    if (compareDecimals(settledAmount, payable) > 0) {
      throw new BadRequestException(
        `Payment amount ${formatDecimal(settledAmount, PAYMENT_SCALE)} exceeds outstanding balance ${formatDecimal(payable, PAYMENT_SCALE)}`,
      );
    }

    // Spreading one receipt across several invoices lived in
    // `fin_payment_allocations`, which was dropped with the pre-rewrite
    // accounting schema. Its successor, `ar_allocations`, is keyed to
    // `ar_receipts`/`ar_documents` and cannot address these integer-id rows, so
    // the feature genuinely has no home here. Say so instead of accepting the
    // input and silently recording a single-invoice payment.
    if ((input.allocations ?? []).length > 0) {
      throw new BadRequestException(
        "Splitting one payment across several invoices moved to accounting receipts " +
          "(POST /accounting/ar/receipts). Record this payment against a single invoice.",
      );
    }

    const created = await this.db.transaction(async (tx) => {
      // The check above ran before the lock. Two receipts racing for the same
      // outstanding balance both pass it, so the invoice row is locked and the
      // balance re-read before anything is written.
      const [lockedInvoice] = await tx
        .select({ total: invoices.total, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
        .for("update")
        .limit(1);
      if (!lockedInvoice) throw new NotFoundException("Invoice not found");
      if (lockedInvoice.status === "VOIDED")
        throw new ConflictException("Cannot record payment on voided invoice");

      const [lockedPaid] = await tx
        .select({ totalPaid: sumOfPayments() })
        .from(payments)
        .where(and(eq(payments.invoiceId, invoiceId), eq(payments.orgId, orgId)));
      const lockedPayable = maxPayable(lockedInvoice.total, lockedPaid?.totalPaid);
      if (compareDecimals(settledAmount, lockedPayable) > 0)
        throw new ConflictException(
          `Payment amount ${formatDecimal(settledAmount, PAYMENT_SCALE)} exceeds outstanding balance ${formatDecimal(lockedPayable, PAYMENT_SCALE)} — another payment landed first`,
        );

      const payment = await this.createPayment(
        orgId,
        invoiceId,
        { ...input, createdBy: userId, settledAmount },
        tx,
      );

      await this.posting.postPaymentReceipt(
        orgId,
        userId,
        {
          paymentId: payment.id,
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          currency: invoice.currency,
          amount: Number(settledAmount),
        },
        tx,
      );

      return payment;
    });

    await this.postArFxGainLoss(
      orgId,
      userId,
      invoice,
      created.id,
      settledAmount,
      input.paymentDate,
    );

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId))
      .limit(5);

    const targetUserIds = members.map((m) => m.userId);
    const emit = () =>
      this.dispatch
        .emit({
          eventKey: "accounting.invoice.payment_received",
          orgId,
          actorUserId: userId,
          targetUserIds,
          entityType: "invoice",
          entityId: String(invoiceId),
          title: "Payment received",
          message: `Payment of ${formatDecimal(settledAmount, PAYMENT_SCALE)} received for invoice ${invoice.invoiceNumber}`,
        })
        .catch(logSideEffectFailure("invoice.payment_received notification", { invoiceId, orgId }));
    if (!registerAfterCommit(emit)) void emit();

    this.audit.log({
      action: "accounting.invoice.payment_recorded",
      userId,
      orgId,
      resourceType: "invoice_payment",
      resourceId: String(created.id),
      result: "SUCCESS",
    });

    return created;
  }

  /**
   * Realised FX when a foreign-currency invoice settles.
   *
   * A missing rate must not undo the payment, and it does not: `postRealizedFx`
   * reports it and posts nothing, as it does for an organisation without
   * accounting. Anything else — a closed period, a chart without an FX role —
   * propagates, so a receipt is never recorded without the entry that clears its
   * FX residue. The rewrite dropped the old `accounting_settings.base_currency`
   * read and the invoice's stored `exchange_rate` — the first has no successor
   * table, and the second was never written by the create path, so it was always
   * 1. Both rates now come from the book's own `gl_fx_rates`.
   *
   * The entry is keyed on the payment, so each receipt against an invoice clears
   * its own residue.
   */
  private async postArFxGainLoss(
    orgId: string,
    userId: string,
    invoice: { id: number; currency: string; createdAt: Date | null },
    paymentId: number,
    settledAmount: string,
    paymentDateIso: string,
  ): Promise<void> {
    await this.posting.postRealizedFx(
      orgId,
      userId,
      {
        id: invoice.id,
        currency: invoice.currency,
        issueDate: (invoice.createdAt ?? new Date()).toISOString().slice(0, 10),
      },
      paymentId,
      Number(settledAmount),
      paymentDateIso,
    );
  }
}
