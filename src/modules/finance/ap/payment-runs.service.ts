import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  finPaymentRuns,
  finPaymentRunItems,
  purchaseBills,
  vendorPayments,
  finVendorPaymentAllocations,
  clients,
  accountingSettings,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import { RateResolverService } from "../controls/rate-resolver.service";
import { FxService } from "../controls/fx.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import { checkApprovalPolicy } from "./ap-approval.helper";
import type {
  CreatePaymentRunInput,
  UpdatePaymentRunItemInput,
  ListPaymentRunsQuery,
} from "./dto/finance-ap.schemas";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const PAYMENT_RUN_CACHE_KEY = (orgId: string) => `fin:payment-runs:${orgId}`;

@Injectable()
export class PaymentRunsService {
  private readonly logger = new Logger(PaymentRunsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly journalPosting: JournalPostingService,
    private readonly rateResolver: RateResolverService,
    private readonly fx: FxService,
  ) {}

  async listRuns(orgId: string, query: ListPaymentRunsQuery) {
    const { page, pageSize, status } = query;
    const conds = [eq(finPaymentRuns.orgId, orgId)];
    if (status) conds.push(eq(finPaymentRuns.status, status));

    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });

    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          id: finPaymentRuns.id,
          orgId: finPaymentRuns.orgId,
          name: finPaymentRuns.name,
          scheduledDate: finPaymentRuns.scheduledDate,
          status: finPaymentRuns.status,
          totalAmount: finPaymentRuns.totalAmount,
          approvedBy: finPaymentRuns.approvedBy,
          approvedAt: finPaymentRuns.approvedAt,
          createdBy: finPaymentRuns.createdBy,
          createdAt: finPaymentRuns.createdAt,
          updatedAt: finPaymentRuns.updatedAt,
          itemCount: sql<number>`count(${finPaymentRunItems.id})::int`,
        })
        .from(finPaymentRuns)
        .leftJoin(finPaymentRunItems, eq(finPaymentRunItems.runId, finPaymentRuns.id))
        .where(where)
        .groupBy(finPaymentRuns.id)
        .orderBy(desc(finPaymentRuns.createdAt))
        .offset(offset)
        .limit(limit),
      this.db.select({ c: count() }).from(finPaymentRuns).where(where),
    ]);

    return buildListResponse(items, Number(totalRows[0]?.c ?? 0), { page, pageSize });
  }

  async getRun(orgId: string, runId: number) {
    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);

    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");

    const items = await this.db
      .select({
        id: finPaymentRunItems.id,
        runId: finPaymentRunItems.runId,
        billId: finPaymentRunItems.billId,
        billNumber: purchaseBills.billNumber,
        vendorId: finPaymentRunItems.vendorId,
        vendorName: clients.name,
        amount: finPaymentRunItems.amount,
        status: finPaymentRunItems.status,
        vendorPaymentId: finPaymentRunItems.vendorPaymentId,
        dueDate: purchaseBills.dueDate,
      })
      .from(finPaymentRunItems)
      .leftJoin(purchaseBills, eq(purchaseBills.id, finPaymentRunItems.billId))
      .leftJoin(clients, eq(clients.id, finPaymentRunItems.vendorId))
      .where(eq(finPaymentRunItems.runId, runId));

    return { ...run, items };
  }

  async createRun(orgId: string, userId: string, input: CreatePaymentRunInput) {
    const conds = [
      eq(purchaseBills.orgId, orgId),
      inArray(purchaseBills.status, ["POSTED", "PARTIALLY_PAID"]),
      gt(
        sql<number>`(${purchaseBills.total}::numeric - ${purchaseBills.amountPaid}::numeric)`,
        sql<number>`0.005`,
      ),
    ];

    if (input.filters?.vendorIds?.length) {
      conds.push(inArray(purchaseBills.vendorId, input.filters.vendorIds));
    }
    if (input.filters?.dueBefore) {
      conds.push(lte(purchaseBills.dueDate, input.filters.dueBefore));
    }
    if (input.filters?.minAmount !== undefined) {
      const minAmt = input.filters.minAmount;
      conds.push(
        gt(
          sql<number>`(${purchaseBills.total}::numeric - ${purchaseBills.amountPaid}::numeric)`,
          sql<number>`${minAmt}`,
        ),
      );
    }

    const matchingBills = await this.db
      .select({
        id: purchaseBills.id,
        vendorId: purchaseBills.vendorId,
        total: purchaseBills.total,
        amountPaid: purchaseBills.amountPaid,
      })
      .from(purchaseBills)
      .where(and(...conds));

    const filteredBills = matchingBills.filter((b) => {
      const outstanding = round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0));
      if (input.filters?.maxAmount !== undefined && outstanding > input.filters.maxAmount) {
        return false;
      }
      return outstanding > 0.005;
    });

    if (filteredBills.length === 0) {
      throw new BadRequestException("No outstanding bills match the provided filters");
    }

    const totalAmount = round2(
      filteredBills.reduce((acc, b) => acc + round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0)), 0),
    );

    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(finPaymentRuns)
        .values({
          orgId,
          name: input.name,
          scheduledDate: input.scheduledDate ?? null,
          status: "DRAFT",
          totalAmount: totalAmount.toFixed(4),
          createdBy: userId,
        })
        .returning();

      if (!run) throw new Error("Payment run insert returned no rows");

      await tx.insert(finPaymentRunItems).values(
        filteredBills.map((b) => ({
          runId: run.id,
          billId: b.id,
          vendorId: b.vendorId ?? null,
          amount: round2(Number(b.total ?? 0) - Number(b.amountPaid ?? 0)).toFixed(4),
          status: "PENDING" as const,
        })),
      );

      return run;
    });
  }

  async approveRun(u: CurrentUserContext, runId: number) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "DRAFT") {
      throw new ConflictException(`Payment run is in status ${run.status}; only DRAFT runs can be approved`);
    }

    const total = Number(run.totalAmount ?? 0);
    const check = await checkApprovalPolicy(this.db, orgId, "VENDOR_PAYMENT", total);

    if (check.needsApproval && check.approverUserId && check.approverUserId !== userId) {
      await this.dispatch.emit({
        eventKey: "accounting.bill.approval_requested",
        orgId,
        actorUserId: userId,
        targetUserIds: [check.approverUserId],
        entityType: "payment_run",
        entityId: String(runId),
        variables: { runName: run.name, total },
      });
    }

    const [updated] = await this.db
      .update(finPaymentRuns)
      .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .returning();

    void this.cache.invalidate(PAYMENT_RUN_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.payment_run.approve",
      userId,
      orgId,
      resourceType: "payment_run",
      resourceId: String(runId),
      result: "SUCCESS",
    });

    return updated;
  }

  async executeRun(u: CurrentUserContext, runId: number) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "APPROVED") {
      throw new ConflictException(`Payment run must be APPROVED before execution; current status: ${run.status}`);
    }

    const pendingItems = await this.db
      .select()
      .from(finPaymentRunItems)
      .where(and(eq(finPaymentRunItems.runId, runId), eq(finPaymentRunItems.status, "PENDING")));

    const today = new Date().toISOString().slice(0, 10);
    await this.journalPosting.seedChartOfAccountsForOrg(orgId);

    const settingsRows = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    const baseCurrency = settingsRows[0]?.baseCurrency ?? "INR";

    const billIds = pendingItems.map((item) => item.billId).filter((id): id is number => id !== null);
    const billMap = new Map<number, typeof purchaseBills.$inferSelect>();
    if (billIds.length > 0) {
      const bills = await this.db
        .select()
        .from(purchaseBills)
        .where(and(inArray(purchaseBills.id, billIds), eq(purchaseBills.orgId, orgId)));
      for (const b of bills) billMap.set(b.id, b);
    }

    for (const item of pendingItems) {
      type FxCapture = { billId: number; currency: string; exchangeRate: string; amount: number; userId: string };
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
          void this.postRunItemFxGainLoss(orgId, baseCurrency, fxCapture, today);
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

    void this.cache.invalidate(PAYMENT_RUN_CACHE_KEY(orgId));

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

  async cancelRun(orgId: string, userId: string, runId: number) {
    const rows = await this.db
      .select()
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status === "COMPLETED" || run.status === "CANCELLED") {
      throw new ConflictException(`Payment run is already ${run.status}`);
    }

    await this.db
      .update(finPaymentRuns)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)));

    void this.cache.invalidate(PAYMENT_RUN_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.payment_run.cancel",
      userId,
      orgId,
      resourceType: "payment_run",
      resourceId: String(runId),
      result: "SUCCESS",
    });

    return { id: runId, status: "CANCELLED" };
  }

  async updateRunItem(orgId: string, userId: string, runId: number, itemId: number, input: UpdatePaymentRunItemInput) {
    const runRows = await this.db
      .select({ status: finPaymentRuns.status })
      .from(finPaymentRuns)
      .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)))
      .limit(1);
    const run = runRows[0];
    if (!run) throw new NotFoundException("Payment run not found");
    if (run.status !== "DRAFT") {
      throw new ConflictException("Items can only be modified while the run is in DRAFT status");
    }

    const itemRows = await this.db
      .select()
      .from(finPaymentRunItems)
      .where(and(eq(finPaymentRunItems.id, itemId), eq(finPaymentRunItems.runId, runId)))
      .limit(1);
    const item = itemRows[0];
    if (!item) throw new NotFoundException("Payment run item not found");

    if (input.excluded === true) {
      await this.db
        .delete(finPaymentRunItems)
        .where(and(eq(finPaymentRunItems.id, itemId), eq(finPaymentRunItems.runId, runId)));
    } else if (input.amount !== undefined) {
      const billRows = await this.db
        .select({ total: purchaseBills.total, amountPaid: purchaseBills.amountPaid })
        .from(purchaseBills)
        .where(and(eq(purchaseBills.id, item.billId), eq(purchaseBills.orgId, orgId)))
        .limit(1);
      const bill = billRows[0];
      if (bill) {
        const outstanding = round2(Number(bill.total ?? 0) - Number(bill.amountPaid ?? 0));
        if (input.amount > outstanding + 0.005) {
          throw new BadRequestException(
            `Amount ${input.amount.toFixed(2)} exceeds bill outstanding ${outstanding.toFixed(2)}`,
          );
        }
      }

      await this.db
        .update(finPaymentRunItems)
        .set({ amount: input.amount.toFixed(4) })
        .where(and(eq(finPaymentRunItems.id, itemId), eq(finPaymentRunItems.runId, runId)));

      const itemTotals = await this.db
        .select({ total: sql<string>`COALESCE(sum(${finPaymentRunItems.amount}::numeric), 0)::text` })
        .from(finPaymentRunItems)
        .where(eq(finPaymentRunItems.runId, runId));

      const newTotal = round2(Number(itemTotals[0]?.total ?? 0));
      await this.db
        .update(finPaymentRuns)
        .set({ totalAmount: newTotal.toFixed(4), updatedAt: new Date() })
        .where(and(eq(finPaymentRuns.id, runId), eq(finPaymentRuns.orgId, orgId)));
    }

    this.audit.log({
      action: "accounting.payment_run.update_item",
      userId,
      orgId,
      resourceType: "payment_run_item",
      resourceId: String(itemId),
      metadata: { runId, input },
      result: "SUCCESS",
    });

    return { id: itemId, updated: true };
  }

  private async postRunItemFxGainLoss(
    orgId: string,
    baseCurrency: string,
    capture: { billId: number; currency: string; exchangeRate: string; amount: number; userId: string },
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
      const user: CurrentUserContext = {
        userId: capture.userId,
        orgId,
        role: "system",
        isOrgOwner: false,
        tokenScopes: null,
        sessionId: "",
      };

      this.fx
        .postRealizedGainLoss(user, {
          sourceType: "purchase_bill",
          sourceId: String(capture.billId),
          baseAmountBooked,
          baseAmountSettled,
          counterPurpose: "AP",
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `FX gain/loss post failed for purchase_bill ${capture.billId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.logger.warn(
        `No exchange rate for FX on purchase_bill ${capture.billId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
