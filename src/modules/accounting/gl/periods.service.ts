import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, lte, or } from "drizzle-orm";
import {
  accountingPeriods,
  accountingSettings,
  journalEntries,
  purchaseBills,
  finBankTransactions,
  finApprovalRequests,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { GeneratePeriodsInput } from "./dto/periods.schemas";

const PERIODS_CACHE_TTL = 60;
const PERIODS_LOCAL_KEY = "accounting:periods";

function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async listPeriods(orgId: string) {
    return this.cache.cachedForOrg(orgId, PERIODS_LOCAL_KEY, () => this.fetchPeriods(orgId), PERIODS_CACHE_TTL);
  }

  private async fetchPeriods(orgId: string) {
    return this.db
      .select()
      .from(accountingPeriods)
      .where(eq(accountingPeriods.orgId, orgId))
      .orderBy(accountingPeriods.startDate);
  }

  async generatePeriods(orgId: string, userId: string, input: GeneratePeriodsInput) {
    const { year } = input;

    const settingsRows = await this.db
      .select({ fiscalYearStartMonth: accountingSettings.fiscalYearStartMonth })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);

    const startMonth = settingsRows[0]?.fiscalYearStartMonth ?? 1;

    const toInsert: { orgId: string; name: string; startDate: string; endDate: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const rawMonth = ((startMonth - 1 + i) % 12) + 1;
      const periodYear = rawMonth < startMonth ? year + 1 : year;
      const startDate = isoDate(periodYear, rawMonth, 1);
      const endDate = isoDate(periodYear, rawMonth, lastDayOfMonth(periodYear, rawMonth));
      const name = `${monthName(rawMonth)} ${periodYear}`;
      toInsert.push({ orgId, name, startDate, endDate });
    }

    const inserted = await this.db
      .insert(accountingPeriods)
      .values(toInsert)
      .onConflictDoNothing()
      .returning({ id: accountingPeriods.id });
    const created = inserted.length;

    await this.cache.invalidateForOrg(orgId, PERIODS_LOCAL_KEY);
    this.audit.log({ action: "accounting.periods.generated", userId, orgId, resourceType: "accounting_period", resourceId: String(input.year), result: "SUCCESS" });
    return { created, total: toInsert.length };
  }

  async getCloseChecklist(orgId: string, periodId: number) {
    const period = await this.db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .limit(1);
    if (!period[0]) throw new NotFoundException("Period not found");

    const { startDate, endDate } = period[0];

    const [draftJournalRows, draftBillRows, unreconciledRows, pendingRows] =
      await Promise.all([
        this.db
          .select({ c: count() })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.orgId, orgId),
              gte(journalEntries.entryDate, startDate),
              lte(journalEntries.entryDate, endDate),
              or(
                eq(journalEntries.status, "DRAFT"),
                eq(journalEntries.status, "PENDING_APPROVAL"),
              ),
            ),
          ),
        this.db
          .select({ c: count() })
          .from(purchaseBills)
          .where(
            and(
              eq(purchaseBills.orgId, orgId),
              gte(purchaseBills.billDate, startDate),
              lte(purchaseBills.billDate, endDate),
              eq(purchaseBills.status, "DRAFT"),
            ),
          ),
        this.db
          .select({ c: count() })
          .from(finBankTransactions)
          .where(
            and(
              eq(finBankTransactions.orgId, orgId),
              gte(finBankTransactions.txnDate, startDate),
              lte(finBankTransactions.txnDate, endDate),
              or(
                eq(finBankTransactions.status, "UNMATCHED"),
                eq(finBankTransactions.status, "SUGGESTED"),
              ),
            ),
          ),
        this.db
          .select({ c: count() })
          .from(finApprovalRequests)
          .where(
            and(
              eq(finApprovalRequests.orgId, orgId),
              eq(finApprovalRequests.status, "PENDING"),
            ),
          ),
      ]);

    const [draftJournals] = draftJournalRows;
    const [draftBills] = draftBillRows;
    const [unreconciledTxns] = unreconciledRows;
    const [pendingApprovals] = pendingRows;

    const draftJournalCount = Number(draftJournals?.c ?? 0);
    const draftBillCount = Number(draftBills?.c ?? 0);
    const unreconciledCount = Number(unreconciledTxns?.c ?? 0);
    const pendingApprovalCount = Number(pendingApprovals?.c ?? 0);

    return {
      period: period[0],
      checklist: {
        noDraftJournals: { passed: draftJournalCount === 0, count: draftJournalCount },
        noDraftBills: { passed: draftBillCount === 0, count: draftBillCount },
        noUnreconciledTransactions: { passed: unreconciledCount === 0, count: unreconciledCount },
        noPendingApprovals: { passed: pendingApprovalCount === 0, count: pendingApprovalCount },
      },
      canClose:
        draftJournalCount === 0 &&
        draftBillCount === 0 &&
        unreconciledCount === 0 &&
        pendingApprovalCount === 0,
    };
  }

  async closePeriod(orgId: string, userId: string, periodId: number) {
    const period = await this.db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .limit(1);
    if (!period[0]) throw new NotFoundException("Period not found");
    if (period[0].status !== "OPEN" && period[0].status !== "CLOSING") {
      throw new BadRequestException(`Cannot close a period in status ${period[0].status}`);
    }

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(accountingPeriods)
        .set({ status: "CLOSED", closedBy: userId, closedAt: new Date() })
        .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
        .returning();
      const row = rows[0];
      if (row) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "accounting_period",
          aggregateId: String(periodId),
          aggregateVersion: Date.now(),
          eventType: "accounting.period.closed",
          payload: {
            organization_id: orgId,
            period_id: periodId,
            period_name: row.name,
            actor_user_id: userId,
          },
          occurredAt: new Date(),
        });
      }
      return rows;
    });

    await this.cache.invalidateForOrg(orgId, PERIODS_LOCAL_KEY);
    this.audit.log({ action: "accounting.period.closed", userId, orgId, resourceType: "accounting_period", resourceId: String(periodId) });

    await this.dispatch.emit({
      eventKey: "accounting.period.closed",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "accounting_period",
      entityId: String(periodId),
      title: "Period Closed",
      message: `Accounting period "${updated?.name ?? periodId}" has been closed.`,
    });

    return updated;
  }

  async lockPeriod(orgId: string, userId: string, periodId: number) {
    const period = await this.db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .limit(1);
    if (!period[0]) throw new NotFoundException("Period not found");
    if (period[0].status !== "CLOSED") {
      throw new BadRequestException(`Period must be CLOSED before locking (current: ${period[0].status})`);
    }

    const [updated] = await this.db
      .update(accountingPeriods)
      .set({ status: "LOCKED", lockedBy: userId, lockedAt: new Date() })
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .returning();

    await this.cache.invalidateForOrg(orgId, PERIODS_LOCAL_KEY);
    this.audit.log({ action: "accounting.period.locked", userId, orgId, resourceType: "accounting_period", resourceId: String(periodId) });
    return updated;
  }

  async reopenPeriod(orgId: string, userId: string, periodId: number) {
    const period = await this.db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .limit(1);
    if (!period[0]) throw new NotFoundException("Period not found");
    if (period[0].status !== "LOCKED" && period[0].status !== "CLOSED") {
      throw new BadRequestException(`Period must be LOCKED or CLOSED to reopen (current: ${period[0].status})`);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(accountingPeriods)
        .set({ status: "OPEN" })
        .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)));

      await tx.insert(finApprovalRequests).values({
        orgId,
        recordType: "PERIOD_REOPEN",
        recordId: periodId,
        status: "APPROVED",
        requestedBy: userId,
        decidedBy: userId,
        decidedAt: new Date(),
        decisionComment: `Period reopened by ${userId}`,
      });
    });

    await this.cache.invalidateForOrg(orgId, PERIODS_LOCAL_KEY);
    this.audit.log({ action: "accounting.period.reopened", userId, orgId, resourceType: "accounting_period", resourceId: String(periodId) });

    await this.dispatch.emit({
      eventKey: "accounting.period.reopened",
      orgId,
      actorUserId: userId,
      targetUserIds: [userId],
      entityType: "accounting_period",
      entityId: String(periodId),
      title: "Period Reopened",
      message: `Accounting period "${period[0].name}" has been reopened.`,
    });

    return { id: periodId, status: "OPEN" };
  }

  async assertPeriodOpen(orgId: string, date: Date): Promise<void> {
    const dateStr = isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const locked = await this.db
      .select({ id: accountingPeriods.id, status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.orgId, orgId),
          lte(accountingPeriods.startDate, dateStr),
          gte(accountingPeriods.endDate, dateStr),
        ),
      )
      .limit(1);

    const period = locked[0];
    if (period && (period.status === "LOCKED" || period.status === "CLOSED")) {
      throw new ConflictException(`Accounting period is ${period.status}. Cannot post to a closed or locked period.`);
    }
  }
}
