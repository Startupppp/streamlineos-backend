import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  organizationMembers,
  users,
  leavePolicies,
  hrLeaveLedger,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { CronLeaveResetService } from "./cron-leave-reset.service";

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildPeriodLabel(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

const ACCRUAL_BATCH_SIZE = 500;

@Injectable()
export class CronLeaveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reset: CronLeaveResetService,
  ) {}

  async runMonthlyLeaveReset(): Promise<{
    monthlyAccrual: { accruedCount: number };
    monthlyExpiry: { expiredCount: number };
    yearlyReset: { resetCount: number } | null;
  }> {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;

    let totalAccruedCount = 0;
    let totalExpiredCount = 0;
    let totalYearlyResetCount: number | null = null;

    await forEachOrg(this.db, "monthly-leave-reset", async (tx, orgId) => {
      const sweepStart = Date.now();

      const accrual = await this.accrueMonthlyLeaves(now, orgId);
      totalAccruedCount += accrual.accruedCount;

      const expiry = await this.expireUnusedMonthlyLeaves(orgId);
      totalExpiredCount += expiry.expiredCount;

      const yearStartMonth = await this.reset.resolveLeaveYearStartMonth(tx, orgId);
      let resetCount: number | undefined;
      if (yearStartMonth === currentMonth) {
        const result = await this.reset.resetYearlyLeaveBalances(tx, orgId, now.getFullYear());
        totalYearlyResetCount = (totalYearlyResetCount ?? 0) + result.resetCount;
        resetCount = result.resetCount;
      }

      logger.info("[monthly-leave-reset] org sweep complete", {
        orgId,
        durationMs: Date.now() - sweepStart,
        accruedCount: accrual.accruedCount,
        expiredCount: expiry.expiredCount,
        ...(resetCount !== undefined ? { yearlyResetCount: resetCount } : {}),
      });
    });

    return {
      monthlyAccrual: { accruedCount: totalAccruedCount },
      monthlyExpiry: { expiredCount: totalExpiredCount },
      yearlyReset: totalYearlyResetCount !== null ? { resetCount: totalYearlyResetCount } : null,
    };
  }

  async accrueMonthlyLeaves(now: Date, orgId: string): Promise<{ accruedCount: number }> {
    const year = now.getFullYear();
    const monthIdx = now.getMonth();
    const periodLabel = buildPeriodLabel(year, monthIdx);
    const effectiveDate = toDateStr(new Date(year, monthIdx, 1));

    const monthlyPolicies = await this.db
      .select({
        leaveTypeId: leavePolicies.leaveTypeId,
        accrualRate: leavePolicies.accrualRate,
        maxBalance: leavePolicies.maxBalance,
      })
      .from(leavePolicies)
      .where(
        and(
          eq(leavePolicies.orgId, orgId),
          eq(leavePolicies.accrualType, "MONTHLY"),
          eq(leavePolicies.isActive, true),
        ),
      );

    if (monthlyPolicies.length === 0) return { accruedCount: 0 };

    const leaveTypeIds = monthlyPolicies.map((p) => p.leaveTypeId);

    const activeMembers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

    if (activeMembers.length === 0) return { accruedCount: 0 };

    const existingLedgerEntries = await this.db
      .select({
        userId: hrLeaveLedger.userId,
        leaveTypeId: hrLeaveLedger.leaveTypeId,
      })
      .from(hrLeaveLedger)
      .where(
        and(
          eq(hrLeaveLedger.orgId, orgId),
          inArray(hrLeaveLedger.leaveTypeId, leaveTypeIds),
          eq(hrLeaveLedger.txnType, "accrual"),
          eq(hrLeaveLedger.period, periodLabel),
          eq(hrLeaveLedger.source, "cron"),
        ),
      );

    const alreadyAccruedSet = new Set(
      existingLedgerEntries.map((e) => `${e.userId}:${e.leaveTypeId}`),
    );

    const existingBalances = await this.db
      .select({
        userId: leaveBalances.userId,
        leaveTypeId: leaveBalances.leaveTypeId,
        balance: leaveBalances.balance,
      })
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.orgId, orgId),
          inArray(leaveBalances.leaveTypeId, leaveTypeIds),
          eq(leaveBalances.year, year),
        ),
      );

    const balanceMap = new Map(
      existingBalances.map((b) => [`${b.userId}:${b.leaveTypeId}`, Number(b.balance)]),
    );

    type AccrualCandidate = {
      userId: string;
      leaveTypeId: number;
      rate: number;
      maxBalance: number | null;
      newBalance: number;
      granted: number;
      hasExistingBalance: boolean;
    };

    const candidates: AccrualCandidate[] = [];

    for (const policy of monthlyPolicies) {
      const rate = Number(policy.accrualRate);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const maxBalance =
        policy.maxBalance !== null && Number.isFinite(Number(policy.maxBalance))
          ? Number(policy.maxBalance)
          : null;

      for (const member of activeMembers) {
        const key = `${member.userId}:${policy.leaveTypeId}`;
        if (alreadyAccruedSet.has(key)) continue;

        const current = balanceMap.get(key) ?? 0;
        const next =
          maxBalance !== null ? Math.min(current + rate, maxBalance) : current + rate;
        const granted = next - current;
        if (granted <= 0) continue;

        candidates.push({
          userId: member.userId,
          leaveTypeId: policy.leaveTypeId,
          rate,
          maxBalance,
          newBalance: next,
          granted,
          hasExistingBalance: balanceMap.has(key),
        });
      }
    }

    if (candidates.length === 0) return { accruedCount: 0 };

    let accruedCount = 0;

    for (let i = 0; i < candidates.length; i += ACCRUAL_BATCH_SIZE) {
      const batch = candidates.slice(i, i + ACCRUAL_BATCH_SIZE);

      await this.db.transaction(async (tx) => {
        const newBalanceRows = batch
          .filter((c) => !c.hasExistingBalance)
          .map((c) => ({
            orgId,
            userId: c.userId,
            leaveTypeId: c.leaveTypeId,
            year,
            balance: c.newBalance.toFixed(2),
          }));

        if (newBalanceRows.length > 0)
          await tx.insert(leaveBalances).values(newBalanceRows).onConflictDoNothing();

        const updateRows = batch.filter((c) => c.hasExistingBalance);

        if (updateRows.length > 0) {
          const valsSql = sql.join(
            updateRows.map((c) => sql`(${c.userId}, ${c.leaveTypeId}, ${c.rate}, ${c.maxBalance})`),
            sql`, `,
          );
          await tx.execute(sql`
            UPDATE leave_balances AS lb
            SET balance = CASE
              WHEN v.max_b IS NOT NULL
                THEN LEAST(lb.balance::decimal + v.rate::decimal, v.max_b::decimal)
              ELSE lb.balance::decimal + v.rate::decimal
            END
            FROM (VALUES ${valsSql}) AS v(uid, ltid, rate, max_b)
            WHERE lb.org_id = ${orgId}
              AND lb.user_id = v.uid
              AND lb.leave_type_id = v.ltid::integer
              AND lb.year = ${year}
          `);
        }

        const ledgerRows = batch.map((c) => ({
          orgId,
          userId: c.userId,
          leaveTypeId: c.leaveTypeId,
          txnType: "accrual" as const,
          days: c.granted.toFixed(2),
          effectiveDate,
          period: periodLabel,
          source: "cron" as const,
          note: "Monthly leave accrual from leave_policies",
          payrollStatus: "pending" as const,
        }));

        await tx.insert(hrLeaveLedger).values(ledgerRows);
      });

      accruedCount += batch.length;
    }

    return { accruedCount };
  }

  private async expireUnusedMonthlyLeaves(orgId: string): Promise<{ expiredCount: number }> {
    const now = new Date();
    const currentYear = now.getFullYear();
    const prevMonthIdx = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const prevMonthYear = now.getMonth() === 0 ? currentYear - 1 : currentYear;
    const monthStartStr = toDateStr(new Date(prevMonthYear, prevMonthIdx, 1));
    const monthEndStr = toDateStr(new Date(prevMonthYear, prevMonthIdx + 1, 0));
    const periodLabel = buildPeriodLabel(prevMonthYear, prevMonthIdx);

    const monthlyPolicies = await this.db
      .select({
        leaveTypeId: leavePolicies.leaveTypeId,
        accrualRate: leavePolicies.accrualRate,
        orgId: leavePolicies.orgId,
      })
      .from(leavePolicies)
      .where(
        and(
          eq(leavePolicies.orgId, orgId),
          eq(leavePolicies.accrualType, "MONTHLY"),
          eq(leavePolicies.isActive, true),
        ),
      );

    if (monthlyPolicies.length === 0) return { expiredCount: 0 };

    const monthlyLeaveTypeIds = monthlyPolicies.map((p) => p.leaveTypeId);
    const policyByTypeId = new Map(monthlyPolicies.map((p) => [p.leaveTypeId, p]));

    const positiveBalances = await this.db.query.leaveBalances.findMany({
      where: and(
        eq(leaveBalances.orgId, orgId),
        inArray(leaveBalances.leaveTypeId, monthlyLeaveTypeIds),
        eq(leaveBalances.year, prevMonthYear),
        gt(leaveBalances.balance, "0"),
      ),
      columns: { id: true, orgId: true, userId: true, leaveTypeId: true, balance: true },
    });
    if (positiveBalances.length === 0) return { expiredCount: 0 };

    const usedLeaveResults = await this.db
      .select({ userId: leaveRequests.userId, leaveTypeId: leaveRequests.leaveTypeId })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          inArray(leaveRequests.leaveTypeId, monthlyLeaveTypeIds),
          eq(leaveRequests.status, "APPROVED"),
          gte(leaveRequests.startDate, monthStartStr),
          lte(leaveRequests.endDate, monthEndStr),
        ),
      )
      .groupBy(leaveRequests.userId, leaveRequests.leaveTypeId);

    const usedSet = new Set(usedLeaveResults.map((r) => `${r.userId}:${r.leaveTypeId}`));

    let expiredCount = 0;
    for (const bal of positiveBalances) {
      if (usedSet.has(`${bal.userId}:${bal.leaveTypeId}`)) continue;

      const policy = policyByTypeId.get(bal.leaveTypeId);
      if (!policy || policy.orgId !== bal.orgId) continue;

      const expiryAmount = Number(policy.accrualRate ?? 1);
      const newBalance = Math.max(0, Number(bal.balance) - expiryAmount);
      const deducted = Number(bal.balance) - newBalance;
      if (deducted <= 0) continue;

      await this.db.transaction(async (tx) => {
        await tx
          .update(leaveBalances)
          .set({ balance: newBalance.toString() })
          .where(eq(leaveBalances.id, bal.id));

        await tx.insert(hrLeaveLedger).values({
          orgId: bal.orgId,
          userId: bal.userId,
          leaveTypeId: bal.leaveTypeId,
          txnType: "expiry",
          days: String(deducted),
          effectiveDate: monthEndStr,
          period: periodLabel,
          source: "cron",
          note: "Monthly leave expiry",
          payrollStatus: "pending",
        });
      });

      expiredCount++;
    }

    return { expiredCount };
  }

}
