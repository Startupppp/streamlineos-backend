import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { accTaxPayments } from "../../db/schema/finance-tax";
import { accountingPeriods } from "../../db/schema/accounting-core";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { FinancePostingService } from "../accounting/finance-posting.service";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import type { CreateTaxPaymentInput, ListTaxPaymentsQuery } from "./dto/tax-payments.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class TaxPaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly posting: FinancePostingService,
  ) {}

  async list(orgId: string, query: ListTaxPaymentsQuery) {
    const cacheKey = `fin:tax-payments:${orgId}:${query.page}:${query.pageSize}:${query.taxType ?? ""}:${query.from ?? ""}:${query.to ?? ""}`;
    return this.cache.cached(cacheKey, async () => {
      const { limit, offset } = paginateOffset(query);
      const conditions = [eq(accTaxPayments.orgId, orgId)];
      if (query.taxType) conditions.push(eq(accTaxPayments.taxType, query.taxType));
      if (query.from) conditions.push(gte(accTaxPayments.paidDate, query.from));
      if (query.to) conditions.push(lte(accTaxPayments.paidDate, query.to));
      const where = and(...conditions);
      const [items, totals] = await Promise.all([
        this.db.select().from(accTaxPayments).where(where).orderBy(desc(accTaxPayments.createdAt)).limit(limit).offset(offset),
        this.db.select({ c: count() }).from(accTaxPayments).where(where),
      ]);
      return buildListResponse(items, Number(totals[0]?.c ?? 0), query);
    }, 120);
  }

  async create(u: CurrentUserContext, input: CreateTaxPaymentInput) {
    const { orgId, userId } = u;

    const existing = await this.db
      .select({ id: accTaxPayments.id })
      .from(accTaxPayments)
      .where(
        and(
          eq(accTaxPayments.orgId, orgId),
          eq(accTaxPayments.reference, input.reference),
          eq(accTaxPayments.taxType, input.taxType),
        ),
      )
      .limit(1);

    if (existing[0]) {
      throw new ConflictException(`Tax payment with reference '${input.reference}' already exists`);
    }

    const taxPayableAccountId = await this.posting.resolveSystemAccount(orgId, "TAX_PAYABLE");
    const bankClearingAccountId = await this.posting.resolveSystemAccount(orgId, "BANK_CLEARING");

    const postResult = await this.posting.postJournal(u, {
      entryDate: input.paidDate,
      description: `Tax payment: ${input.taxType} ${input.periodStart} to ${input.periodEnd} [${input.reference}]`,
      sourceType: "TAX_PAYMENT",
      sourceId: `${orgId}:${input.taxType}:${input.reference}`,
      sourceEvent: "pay",
      lines: [
        { accountId: taxPayableAccountId, debit: input.amount },
        { accountId: bankClearingAccountId, credit: input.amount },
      ],
    });

    const [payment] = await this.db
      .insert(accTaxPayments)
      .values({
        orgId,
        taxType: input.taxType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amount: input.amount,
        paidDate: input.paidDate,
        reference: input.reference,
        journalEntryId: postResult.entryId,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();

    await this.cache.invalidatePattern(`fin:tax-payments:${orgId}:*`);
    await this.cache.invalidatePattern(`fin:tax-dashboard:${orgId}:*`);

    this.audit.log({
      action: "accounting.tax_payment.create",
      userId,
      orgId,
      resourceType: "tax_payment",
      resourceId: String(payment?.id),
      metadata: { taxType: input.taxType, amount: input.amount, reference: input.reference },
      result: "SUCCESS",
    });

    void this.dispatch.emit({
      eventKey: "accounting.tax.payment_posted",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "tax_payment",
      entityId: String(payment?.id),
      variables: { taxType: input.taxType, amount: input.amount, reference: input.reference },
    }).catch(() => undefined);

    return payment;
  }

  async delete(u: CurrentUserContext, paymentId: number) {
    const { orgId, userId } = u;
    const today = todayIso();

    const [payment] = await this.db
      .select()
      .from(accTaxPayments)
      .where(and(eq(accTaxPayments.id, paymentId), eq(accTaxPayments.orgId, orgId)))
      .limit(1);

    if (!payment) throw new NotFoundException(`Tax payment ${paymentId} not found`);

    if (payment.paidDate && payment.paidDate !== today) {
      throw new BadRequestException("Tax payments can only be deleted on the same day they were created");
    }

    await this.assertOpenPeriod(orgId, today);

    if (payment.journalEntryId) {
      await this.posting.reverseJournal(u, payment.journalEntryId, `Reversal of tax payment ${payment.reference}`);
    }

    await this.db.delete(accTaxPayments).where(and(eq(accTaxPayments.id, paymentId), eq(accTaxPayments.orgId, orgId)));

    await this.cache.invalidatePattern(`fin:tax-payments:${orgId}:*`);
    await this.cache.invalidatePattern(`fin:tax-dashboard:${orgId}:*`);

    this.audit.log({
      action: "accounting.tax_payment.delete",
      userId,
      orgId,
      resourceType: "tax_payment",
      resourceId: String(paymentId),
      metadata: { reference: payment.reference, amount: payment.amount },
      result: "SUCCESS",
    });

    return { deleted: true };
  }

  private async assertOpenPeriod(orgId: string, date: string): Promise<void> {
    const periods = await this.db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.orgId, orgId),
          lte(accountingPeriods.startDate, date),
          gte(accountingPeriods.endDate, date),
        ),
      )
      .limit(1);

    if (!periods[0]) return;
    const { status } = periods[0];
    if (status === "CLOSED" || status === "LOCKED") {
      throw new BadRequestException(`Accounting period covering ${date} is ${status.toLowerCase()}`);
    }
  }
}
