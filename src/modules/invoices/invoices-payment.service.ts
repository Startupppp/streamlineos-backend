import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invoices, payments, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { DbOrTx } from "../accounting/kernel/sequence.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { InvoicesPostingService } from "./invoices-posting.service";
import type { RecordPaymentInput } from "./dto/invoice-write.schemas";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../common/logger/side-effect";

@Injectable()
export class InvoicesPaymentService {
  private readonly classLogger = new Logger(InvoicesPaymentService.name);

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
    data: RecordPaymentInput & { createdBy: string },
    tx: DbOrTx,
  ) {
    const [payment] = await tx
      .insert(payments)
      .values({
        orgId,
        invoiceId,
        amount: data.amount.toFixed(2),
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

    const [{ totalPaid }] = await this.db
      .select({
        totalPaid: sql<number>`COALESCE(sum(${payments.amount}::numeric), 0)::float`,
      })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.orgId, orgId)));
    const remaining = Number(invoice.total ?? 0) - totalPaid;
    if (input.amount > remaining + 0.01) {
      throw new BadRequestException(
        `Payment amount ${input.amount.toFixed(2)} exceeds outstanding balance ${remaining.toFixed(2)}`,
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
      const payment = await this.createPayment(
        orgId,
        invoiceId,
        { ...input, createdBy: userId },
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
          amount: input.amount,
        },
        tx,
      );

      return payment;
    });

    await this.postArFxGainLoss(orgId, userId, invoice, input.amount, input.paymentDate);

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
          message: `Payment of ${input.amount.toFixed(2)} received for invoice ${invoice.invoiceNumber}`,
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
   * Fire-and-forget on purpose: the payment is already recorded and a missing
   * rate must not undo it. The rewrite dropped the old
   * `accounting_settings.base_currency` read and the invoice's stored
   * `exchange_rate` — the first has no successor table, and the second was never
   * written by the create path, so it was always 1. Both rates now come from the
   * book's own `gl_fx_rates`.
   */
  private async postArFxGainLoss(
    orgId: string,
    userId: string,
    invoice: { id: number; currency: string; createdAt: Date | null },
    settledAmount: number,
    paymentDateIso: string,
  ): Promise<void> {
    try {
      await this.posting.postRealizedFx(
        orgId,
        userId,
        {
          id: invoice.id,
          currency: invoice.currency,
          issueDate: (invoice.createdAt ?? new Date()).toISOString().slice(0, 10),
        },
        settledAmount,
        paymentDateIso,
      );
    } catch (err) {
      this.classLogger.warn(
        `Realised FX post failed for invoice ${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
