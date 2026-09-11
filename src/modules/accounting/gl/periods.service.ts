import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gte, lte, or } from "drizzle-orm";
import {
  accountingPeriods,
  accountingSettings,
  organizationMembers,
  finApprovalRequests,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { getCloseChecklist } from "./lib/period-close-checklist";
import type { GeneratePeriodsInput } from "./dto/periods.schemas";

const PERIODS_CACHE_TTL = 60;
const periodsKey = (orgId: string) => `accounting:periods:${orgId}`;

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
    return this.cache.cached(periodsKey(orgId), () => this.fetchPeriods(orgId), PERIODS_CACHE_TTL);
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

    await this.cache.invalidate(periodsKey(orgId));
    this.audit.log({ action: "accounting.periods.generated", userId, orgId, resourceType: "accounting_period", resourceId: String(input.year), result: "SUCCESS" });
    return { created, total: toInsert.length };
  }

  /** @see lib/period-close-checklist.ts */
  async getCloseChecklist(orgId: string, periodId: number) {
    return getCloseChecklist(this.db, orgId, periodId);
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

    const [actorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const closedByMembershipId = actorMember?.id ?? null;

    const [updated] = await this.db
      .update(accountingPeriods)
      .set({ status: "CLOSED", closedByMembershipId, closedAt: new Date() })
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .returning();

    await this.cache.invalidate(periodsKey(orgId));
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

    const [lockActor] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const lockedByMembershipId = lockActor?.id ?? null;

    const [updated] = await this.db
      .update(accountingPeriods)
      .set({ status: "LOCKED", lockedByMembershipId, lockedAt: new Date() })
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.orgId, orgId)))
      .returning();

    await this.cache.invalidate(periodsKey(orgId));
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

    await this.cache.invalidate(periodsKey(orgId));
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
