import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { accTaxPayments } from "../../../db/schema/accounting/finance-tax";
import { accountingPeriods } from "../../../db/schema/accounting/accounting-core";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { CreateTaxPaymentInput, ListTaxPaymentsQuery } from "./dto/tax-payments.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";

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
    const pageLimit = Math.min(query.limit, 100);
    const cacheKey = `cursor:${query.cursor ?? "first"}:${pageLimit}:${query.taxType ?? ""}:${query.from ?? ""}:${query.to ?? ""}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxPaymentsNamespace(orgId), cacheKey, async () => {
      const conditions = [eq(accTaxPayments.orgId, orgId), isNull(accTaxPayments.archivedAt)];
      if (query.taxType) conditions.push(eq(accTaxPayments.taxType, query.taxType));
      if (query.from) conditions.push(gte(accTaxPayments.paidDate, query.from));
      if (query.to) conditions.push(lte(accTaxPayments.paidDate, query.to));
      if (query.cursor) conditions.push(lt(accTaxPayments.id, query.cursor));
      const projection = {
        id: accTaxPayments.id,
        taxType: accTaxPayments.taxType,
        periodStart: accTaxPayments.periodStart,
        periodEnd: accTaxPayments.periodEnd,
        amount: accTaxPayments.amount,
        paidDate: accTaxPayments.paidDate,
        reference: accTaxPayments.reference,
        journalEntryId: accTaxPayments.journalEntryId,
        notes: accTaxPayments.notes,
        createdBy: accTaxPayments.createdBy,
        createdAt: accTaxPayments.createdAt,
      };
      const rows = await this.db.select(projection).from(accTaxPayments).where(and(...conditions)).orderBy(desc(accTaxPayments.id)).limit(pageLimit + 1);
      const result = buildIdCursorPage(rows, pageLimit, (row) => row.id);
      return { items: result.data, pagination: { limit: pageLimit, hasMore: result.hasMore, nextCursor: result.nextCursor } };
    }, 120);
  }

  async create(u: CurrentUserContext, input: CreateTaxPaymentInput) {
    const actor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId });
    const { orgId, userId } = u;

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

    let payment: typeof accTaxPayments.$inferSelect | undefined;
    try {
      const [inserted] = await this.db
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
      payment = inserted;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as Record<string, unknown>).code === "23505") {
        throw new ConflictException(`Tax payment with reference '${input.reference}' already exists`);
      }
      throw err;
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxPaymentsNamespace(orgId));
    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId));

    this.audit.log({
      action: "accounting.tax_payment.create",
      userId,
      orgId,
      actorMembershipId: actor.membershipId,
      resourceType: "tax_payment",
      resourceId: String(payment?.id),
      metadata: { taxType: input.taxType, amount: input.amount, reference: input.reference },
      result: "SUCCESS",
    });

    await this.dispatch.emit({
      eventKey: "accounting.tax.payment_posted",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "tax_payment",
      entityId: String(payment?.id),
      variables: { taxType: input.taxType, amount: input.amount, reference: input.reference },
    }).catch(logSideEffectFailure("tax payment notification dispatch", { orgId }));

    return payment;
  }

  async delete(u: CurrentUserContext, paymentId: number) {
    const actor = await assertOrganizationActor(this.db, u.orgId, { kind: "user", userId: u.userId });
    const { orgId, userId } = u;
    const today = todayIso();

    const [payment] = await this.db
      .select({
        id: accTaxPayments.id,
        paidDate: accTaxPayments.paidDate,
        journalEntryId: accTaxPayments.journalEntryId,
        reference: accTaxPayments.reference,
        amount: accTaxPayments.amount,
      })
      .from(accTaxPayments)
      .where(and(eq(accTaxPayments.id, paymentId), eq(accTaxPayments.orgId, orgId), isNull(accTaxPayments.archivedAt)))
      .limit(1);

    if (!payment) throw new NotFoundException(`Tax payment ${paymentId} not found`);

    if (payment.paidDate && payment.paidDate !== today) {
      throw new BadRequestException("Tax payments can only be deleted on the same day they were created");
    }

    await this.assertOpenPeriod(orgId, today);

    if (payment.journalEntryId) {
      await this.posting.reverseJournal(u, payment.journalEntryId, `Reversal of tax payment ${payment.reference}`);
    }

    await this.db.update(accTaxPayments).set({ archivedAt: new Date() }).where(and(eq(accTaxPayments.id, paymentId), eq(accTaxPayments.orgId, orgId), isNull(accTaxPayments.archivedAt)));

    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxPaymentsNamespace(orgId));
    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId));

    this.audit.log({
      action: "accounting.tax_payment.delete",
      userId,
      orgId,
      actorMembershipId: actor.membershipId,
      resourceType: "tax_payment",
      resourceId: String(paymentId),
      metadata: { reference: payment.reference, amount: payment.amount },
      result: "SUCCESS",
    });

    return { archived: true };
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
