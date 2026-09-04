import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  invoices,
  payments,
  organizationMembers,
  accountingSettings,
  finPaymentAllocations,
  finReminderLog,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { JournalPostingService, type DbOrTx } from "../accounting/posting/journal-posting.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { ExchangeRateNotFoundError, RateResolverService } from "../finance/controls/rate-resolver.service";
import { FxService } from "../finance/controls/fx.service";
import {
  compareDecimals,
  decimalFromNumber,
  formatDecimal,
  multiplyDecimals,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
} from "../accounting/core/money.util";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { systemActor } from "../../common/auth/system-actor";
import type { RecordPaymentInput } from "./dto/invoice-write.schemas";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { logSideEffectFailure } from "../../common/logger/side-effect";

/**
 * `payments.amount` is `numeric(12,2)`, so a receipt can only ever be recorded to
 * the paisa. Pinning the request amount to that scale once — and comparing the
 * outstanding balance at the same scale — is what keeps the payment register, the
 * allocation subledger and the journal recording one quantity instead of three.
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
  private readonly classLogger = new Logger(InvoicesPaymentService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly posting: JournalPostingService,
    private readonly dispatch: NotificationDispatchService,
    private readonly lifecycle: InvoicesLifecycleService,
    private readonly audit: AuditService,
    private readonly rateResolver: RateResolverService,
    private readonly fx: FxService,
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

    const allocations = input.allocations ?? [];
    const allocatedAmounts = allocations.map((a) =>
      roundDecimal(decimalFromNumber(a.amount), PAYMENT_SCALE),
    );
    if (
      allocations.length > 0 &&
      compareDecimals(sumDecimals(allocatedAmounts), settledAmount) !== 0
    ) {
      throw new BadRequestException(
        "Allocations total must equal payment amount",
      );
    }

    const allocInvoiceIds = allocations.map((a) => a.invoiceId);
    if (allocInvoiceIds.length > 0) {
      const validInvoices = await this.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(eq(invoices.orgId, orgId), inArray(invoices.id, allocInvoiceIds)),
        );
      if (validInvoices.length !== allocInvoiceIds.length) {
        throw new BadRequestException(
          "One or more allocation invoices not found in this organisation",
        );
      }
    }

    await this.posting.seedChartOfAccountsForOrg(orgId);

    const created = await this.db.transaction(async (tx) => {
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

      const touchedIds = new Set([invoiceId]);
      if (allocations.length > 0) {
        await tx.insert(finPaymentAllocations).values(
          allocations.map((a, idx) => ({
            orgId,
            paymentId: payment.id,
            invoiceId: a.invoiceId,
            amount: allocatedAmounts[idx],
          })),
        );
        for (const id of allocations.map((a) => a.invoiceId)) touchedIds.add(id);
        for (const id of touchedIds) {
          await this.lifecycle.recomputeInvoiceBalance(id, tx);
        }
      }

      const paidNow = new Date();
      const touchedIdArr = [...touchedIds];
      const invStatuses = await tx
        .select({ id: invoices.id, status: invoices.status })
        .from(invoices)
        .where(and(inArray(invoices.id, touchedIdArr), eq(invoices.orgId, orgId)));

      const paidInvoiceIds = invStatuses.filter((inv) => inv.status === "PAID").map((inv) => inv.id);

      if (paidInvoiceIds.length > 0) {
        await tx
          .update(finReminderLog)
          .set({ paidAt: paidNow })
          .where(and(
            eq(finReminderLog.orgId, orgId),
            inArray(finReminderLog.invoiceId, paidInvoiceIds),
            eq(finReminderLog.status, "SENT"),
            isNull(finReminderLog.paidAt),
          ));
      }

      await this.posting.postPaymentReceipt(
        {
          orgId,
          paymentId: payment.id,
          invoiceNumber: invoice.invoiceNumber,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          amount: Number(settledAmount),
          createdBy: userId,
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

  private async postArFxGainLoss(
    orgId: string,
    userId: string,
    invoice: { id: number; currency: string; exchangeRate: string },
    paymentId: number,
    allocatedAmount: string,
    paymentDateIso: string,
  ): Promise<void> {
    const settingsRows = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    const baseCurrency = settingsRows[0]?.baseCurrency ?? "INR";

    if (invoice.currency === baseCurrency) return;

    const bookedRate = invoice.exchangeRate ? toDecimal(invoice.exchangeRate) : "1";
    const baseAmountBooked = multiplyDecimals(allocatedAmount, bookedRate);

    try {
      const settledRate = await this.rateResolver.getRateString(
        orgId,
        invoice.currency,
        baseCurrency,
        new Date(`${paymentDateIso}T00:00:00.000Z`),
      );
      const baseAmountSettled = multiplyDecimals(allocatedAmount, toDecimal(settledRate));
      const user = systemActor("invoices.payment.fx-posting", orgId, userId);

      await this.fx.postRealizedGainLoss(user, {
        sourceType: "invoice",
        sourceId: String(invoice.id),
        settlementId: String(paymentId),
        baseAmountBooked,
        baseAmountSettled,
        counterPurpose: "AR",
      });
    } catch (err) {
      if (!(err instanceof ExchangeRateNotFoundError)) throw err;
      this.classLogger.warn(
        `No exchange rate for FX on invoice ${invoice.id}: ${err.message}`,
      );
    }
  }
}
