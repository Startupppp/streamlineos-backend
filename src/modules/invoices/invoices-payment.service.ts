import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invoices,
  payments,
  organizationMembers,
  accountingSettings,
  finPaymentAllocations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { AuditService } from "../../common/audit/audit.service";
import { JournalPostingService, type DbOrTx } from "../accounting/core/journal-posting.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvoicesLifecycleService } from "./invoices-lifecycle.service";
import { RateResolverService } from "../finance/controls/rate-resolver.service";
import { FxService } from "../finance/controls/fx.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { RecordPaymentInput } from "./dto/invoice-write.schemas";

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

    const allocations = input.allocations ?? [];
    const allocatedTotal = allocations.reduce((sum, a) => sum + a.amount, 0);
    if (allocations.length > 0 && Math.abs(allocatedTotal - input.amount) > 0.01) {
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
      const payment = await this.createPayment(
        orgId,
        invoiceId,
        { ...input, createdBy: userId },
        tx,
      );

      if (allocations.length > 0) {
        await tx.insert(finPaymentAllocations).values(
          allocations.map((a) => ({
            orgId,
            paymentId: payment.id,
            invoiceId: a.invoiceId,
            amount: a.amount.toFixed(4),
          })),
        );
        const touchedIds = new Set([
          invoiceId,
          ...allocations.map((a) => a.invoiceId),
        ]);
        for (const id of touchedIds) {
          await this.lifecycle.recomputeInvoiceBalance(id, tx);
        }
      }

      await this.posting.postPaymentReceipt(
        {
          orgId,
          paymentId: payment.id,
          invoiceNumber: invoice.invoiceNumber,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          amount: input.amount,
          createdBy: userId,
        },
        tx,
      );
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "payment",
        aggregateId: String(payment.id),
        aggregateVersion: Date.now(),
        eventType: "accounting.payment.received",
        payload: {
          organization_id: orgId,
          payment_id: payment.id,
          invoice_id: invoiceId,
          invoice_number: invoice.invoiceNumber,
          amount_cents: Math.round(input.amount * 100),
          payment_date: input.paymentDate,
          payment_method: input.paymentMethod,
          actor_user_id: userId,
        },
        occurredAt: new Date(),
      });

      return payment;
    });

    void this.postArFxGainLoss(orgId, userId, invoice, input.amount, input.paymentDate);

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId))
      .limit(5);

    void this.dispatch
      .emit({
        eventKey: "accounting.invoice.payment_received",
        orgId,
        actorUserId: userId,
        targetUserIds: members.map((m) => m.userId),
        entityType: "invoice",
        entityId: String(invoiceId),
        title: "Payment received",
        message: `Payment of ${input.amount.toFixed(2)} received for invoice ${invoice.invoiceNumber}`,
      })
      .catch(() => undefined);

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
    allocatedAmount: number,
    paymentDateIso: string,
  ): Promise<void> {
    const settingsRows = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    const baseCurrency = settingsRows[0]?.baseCurrency ?? "INR";

    if (invoice.currency === baseCurrency) return;

    const bookedRate = Number(invoice.exchangeRate ?? 1);
    const baseAmountBooked = (allocatedAmount * bookedRate).toFixed(4);

    try {
      const settledRate = await this.rateResolver.getRate(
        orgId,
        invoice.currency,
        baseCurrency,
        new Date(`${paymentDateIso}T00:00:00.000Z`),
      );
      const baseAmountSettled = (allocatedAmount * settledRate).toFixed(4);

      const permissions: string[] = [];
      const user: CurrentUserContext = {
        userId,
        orgId,
        role: "system",
        permissions,
        isOrgOwner: false,
        tokenScopes: null,
        sessionId: "",
      };

      this.fx
        .postRealizedGainLoss(user, {
          sourceType: "invoice",
          sourceId: String(invoice.id),
          baseAmountBooked,
          baseAmountSettled,
          counterPurpose: "AR",
        })
        .catch((err: unknown) => {
          this.classLogger.warn(
            `FX gain/loss post failed for invoice ${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.classLogger.warn(
        `No exchange rate for FX on invoice ${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
