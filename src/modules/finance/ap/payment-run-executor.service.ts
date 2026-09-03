import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { roundDecimal, toDecimal } from "../../accounting/core/money.util";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import { RateResolverService } from "../controls/rate-resolver.service";
import { FxService } from "../controls/fx.service";
import { systemActor } from "../../../common/auth/system-actor";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
        and(
          eq(finPaymentRunItems.orgId, orgId),
          eq(finPaymentRunItems.runId, runId),
          eq(finPaymentRunItems.status, "PENDING"),
        ),
      )
      .limit(1000);

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
      .where(and(inArray(purchaseBills.id, billIds), eq(purchaseBills.orgId, orgId)))
      .limit(billIds.length);
      for (const b of bills) billMap.set(b.id, b);
    }

    for (const item of pendingItems) {
      type FxCapture = {
        billId: number;
        /** The `vendor_payments` row this item created — one instalment, one FX result. */
        vendorPaymentId: number;
        currency: string;
        exchangeRate: string;
        amount: number;
        userId: string;
      };
      let fxCapture: FxCapture | null = null;

      /*
       * One economic quantity, one number. `vendor_payments.amount` is
       * numeric(12,2) — a bank moves whole paise and that column is the
       * authoritative record of what left the account — while the run item, the
       * allocation, `amount_paid` and the ledger are all numeric(18,4). Writing
       * the item's raw scale-4 amount to some of them and a separately rounded
       * one to the payment left the register and the AP subledger permanently
       * apart (a Rs 100.0050 item registered Rs 100.00 and allocated Rs 100.0050,
       * because `Number("100.0050").toFixed(2)` is "100.00" in IEEE-754).
       *
       * `paidAmount` is that quantity, in the vendor's currency at scale 2,
       * rounded half-up exactly. Every write below uses it and nothing else.
       */
      const paidAmount = roundDecimal(toDecimal(item.amount), 2);

      try {
        await this.db.transaction(async (tx) => {
          const [payment] = await tx
            .insert(vendorPayments)
            .values({
              orgId,
              billId: item.billId,
              amount: paidAmount,
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
              amount: paidAmount,
            })
            .onConflictDoNothing();

          const billRow = item.billId !== null ? (billMap.get(item.billId) ?? null) : null;
          if (billRow) {
            /*
             * `billMap` is a snapshot taken once for the whole run. Writing an
             * absolute `amount_paid` computed from it silently reverts any
             * manual payment or credit application that committed in between.
             * The increment and the status both move in SQL against the row the
             * statement is already locking.
             */
            const [settled] = await tx
              .update(purchaseBills)
              .set({
                amountPaid: sql`round(${purchaseBills.amountPaid} + ${paidAmount}::numeric, 4)`,
                status: sql`CASE WHEN ${purchaseBills.amountPaid} + ${paidAmount}::numeric >= ${purchaseBills.total} - 0.005 THEN 'PAID' ELSE 'PARTIALLY_PAID' END`,
                updatedAt: new Date(),
              })
              .where(and(eq(purchaseBills.id, item.billId), eq(purchaseBills.orgId, orgId)))
              .returning({ status: purchaseBills.status });

            await this.journalPosting.postVendorPayment(
              {
                orgId,
                paymentId: payment.id,
                billNumber: billRow.billNumber,
                paymentDate: today,
                paymentMethod: "bank_transfer",
                amount: Number(paidAmount),
                createdBy: userId,
              },
              tx,
            );

            /* Read back from the write, not from the pre-run snapshot: whether this
             * payment is the one that settles the bill depends on what else has
             * committed since `billMap` was built. */
            if (settled?.status === "PAID") {
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
                  amount_cents: Math.round(Number(paidAmount) * 100),
                  run_id: runId,
                  actor_user_id: userId,
                },
                occurredAt: new Date(),
              });
            }

            if (billRow.currency !== baseCurrency) {
              fxCapture = {
                billId: billRow.id,
                vendorPaymentId: payment.id,
                currency: billRow.currency,
                exchangeRate: billRow.exchangeRate,
                amount: Number(paidAmount),
                userId,
              };
            }
          }

          await tx
            .update(finPaymentRunItems)
            .set({ status: "PAID", vendorPaymentId: payment.id })
            .where(
              and(eq(finPaymentRunItems.orgId, orgId), eq(finPaymentRunItems.id, item.id)),
            );

          await this.dispatch.emit({
            eventKey: "accounting.payment.recorded",
            orgId,
            actorUserId: userId,
            targetUserIds: [userId],
            entityType: "vendor_payment",
            entityId: String(payment.id),
            variables: { amount: Number(paidAmount), billId: item.billId },
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
          .where(and(eq(finPaymentRunItems.orgId, orgId), eq(finPaymentRunItems.id, item.id)));
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
      vendorPaymentId: number;
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
        settlementId: String(capture.vendorPaymentId),
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
