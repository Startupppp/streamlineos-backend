import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  finPaymentRuns,
  finPaymentRunItems,
  purchaseBills,
  vendorPayments,
  finVendorPaymentAllocations,
  accountingSettings,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import { RateResolverService } from "../controls/rate-resolver.service";
import { FxService } from "../controls/fx.service";
import { systemActor } from "../../../common/auth/system-actor";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class PaymentRunExecutorService {
  private readonly logger = new Logger(PaymentRunExecutorService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly journalPosting: JournalPostingService,
    private readonly rateResolver: RateResolverService,
    private readonly fx: FxService,
  ) {}

  async executeRun(u: CurrentUserContext, runId: number) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "APPROVED")
      throw new ConflictException(
        `Payment run must be APPROVED before execution; current status: ${run.status}`,
      );

    const pendingItems = await this.db
      .select()
      .from(finPaymentRunItems)
      .where(
        and(eq(finPaymentRunItems.runId, runId), eq(finPaymentRunItems.status, "PENDING")),
      );

    const today = new Date().toISOString().slice(0, 10);
    await this.journalPosting.seedChartOfAccountsForOrg(orgId);

    const settingsRows = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    const baseCurrency = settingsRows[0]?.baseCurrency ?? "INR";

    const billIds = pendingItems
      .map((item) => item.billId)
      .filter((id): id is number => id !== null);
    const billMap = new Map<number, typeof purchaseBills.$inferSelect>();
    if (billIds.length > 0) {
      const bills = await this.db
        .select()
        .from(purchaseBills)
        .where(and(inArray(purchaseBills.id, billIds), eq(purchaseBills.orgId, orgId)));
      for (const b of bills) billMap.set(b.id, b);
    }

    for (const item of pendingItems) {
      type FxCapture = {
        billId: number;
        currency: string;
        exchangeRate: string;
        amount: number;
        userId: string;
      };
      let fxCapture: FxCapture | null = null;

      try {
        await this.db.transaction(async (tx) => {
          const [payment] = await tx
            .insert(vendorPayments)
            .values({
              orgId,
              billId: item.billId,
              amount: Number(item.amount).toFixed(2),
              paymentDate: today,
              paymentMethod: "bank_transfer",
              notes: `Payment run ${run.name}`,
              createdBy: userId,
            })
            .returning();

          if (!payment) throw new Error("Vendor payment insert returned no rows");

          await tx
            .insert(finVendorPaymentAllocations)
            .values({
              orgId,
              vendorPaymentId: payment.id,
              billId: item.billId,
              amount: item.amount,
            })
            .onConflictDoNothing();

          const billRow = item.billId !== null ? (billMap.get(item.billId) ?? null) : null;
          if (billRow) {
            const newPaid = round2(Number(billRow.amountPaid ?? 0) + Number(item.amount));
            const total = Number(billRow.total ?? 0);
            const newStatus = newPaid >= total - 0.005 ? "PAID" : "PARTIALLY_PAID";

            await tx
              .update(purchaseBills)
              .set({ amountPaid: newPaid.toFixed(4), status: newStatus, updatedAt: new Date() })
              .where(and(eq(purchaseBills.id, item.billId), eq(purchaseBills.orgId, orgId)));

            await this.journalPosting.postVendorPayment(
              {
                orgId,
                paymentId: payment.id,
                billNumber: billRow.billNumber,
                paymentDate: today,
                paymentMethod: "bank_transfer",
                amount: Number(item.amount),
                createdBy: userId,
              },
              tx,
            );

            if (newStatus === "PAID") {
              await OutboxWriter.emit(tx, {
                eventId: randomUUID(),
                organizationId: orgId,
                aggregateType: "purchase_bill",
                aggregateId: String(item.billId),
                aggregateVersion: Date.now(),
                eventType: "accounting.bill.paid",
                payload: {
                  organization_id: orgId,
                  bill_id: item.billId,
                  bill_number: billRow.billNumber,
                  payment_id: payment.id,
                  amount_cents: Math.round(Number(item.amount) * 100),
                  run_id: runId,
                  actor_user_id: userId,
                },
                occurredAt: new Date(),
              });
            }

            if (billRow.currency !== baseCurrency) {
              fxCapture = {
                billId: billRow.id,
                currency: billRow.currency,
                exchangeRate: billRow.exchangeRate,
                amount: Number(item.amount),
                userId,
              };
            }
          }

          await tx
            .update(finPaymentRunItems)
            .set({ status: "PAID", vendorPaymentId: payment.id })
            .where(eq(finPaymentRunItems.id, item.id));

          await this.dispatch.emit({
            eventKey: "accounting.payment.recorded",
            orgId,
            actorUserId: userId,
            targetUserIds: [userId],
            entityType: "vendor_payment",
            entityId: String(payment.id),
            variables: { amount: Number(item.amount), billId: item.billId },
          });
        });

        if (fxCapture !== null) {
          await this.postRunItemFxGainLoss(orgId, baseCurrency, fxCapture, today);
        }
      } catch (err: unknown) {
        logSideEffectFailure("payment run item execution", { orgId, runId, itemId: item.id })(err);
        await this.db
          .update(finPaymentRunItems)
          .set({ status: "SKIPPED" })
          .where(eq(finPaymentRunItems.id, item.id));
      }
    }

    await this.db
      .update(finPaymentRuns)
      .set({ status: "COMPLETED", updatedAt: new Date() })
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)));

    this.audit.log({
      action: "accounting.payment_run.execute",
      userId,
      orgId,
      resourceType: "payment_run",
      resourceId: String(runId),
      result: "SUCCESS",
    });

    return { id: runId, status: "COMPLETED" };
  }

  private async postRunItemFxGainLoss(
    orgId: string,
    baseCurrency: string,
    capture: {
      billId: number;
      currency: string;
      exchangeRate: string;
      amount: number;
      userId: string;
    },
    paymentDateIso: string,
  ): Promise<void> {
    const bookedRate = Number(capture.exchangeRate ?? 1);
    const baseAmountBooked = (capture.amount * bookedRate).toFixed(4);

    try {
      const settledRate = await this.rateResolver.getRate(
        orgId,
        capture.currency,
        baseCurrency,
        new Date(`${paymentDateIso}T00:00:00.000Z`),
      );
      const baseAmountSettled = (capture.amount * settledRate).toFixed(4);
      const user = systemActor("finance.payment-run.fx-posting", orgId, capture.userId);

      await this.fx.postRealizedGainLoss(user, {
        sourceType: "purchase_bill",
        sourceId: String(capture.billId),
        baseAmountBooked,
        baseAmountSettled,
        counterPurpose: "AP",
      });
    } catch (err: unknown) {
      this.logger.warn(
        `FX gain/loss post failed for purchase_bill ${capture.billId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
