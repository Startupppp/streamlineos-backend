import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
  organizationMembers,
  leavePolicies,
  hrLeaveLedger,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildPeriodLabel(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

@Injectable()
export class CronLeaveService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async runMonthlyLeaveReset(): Promise<{
    monthlyExpiry: { expiredCount: number };
    yearlyReset: { resetCount: number } | null;
  }> {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;

    const monthlyExpiry = await this.expireUnusedMonthlyLeaves();

    const orgIds = (
      await this.db.selectDistinct({ orgId: leaveTypes.orgId }).from(leaveTypes)
    ).map((r) => r.orgId);

    let yearlyReset: { resetCount: number } | null = null;
    let totalResetCount = 0;
    for (const orgId of orgIds) {
      const yearStartMonth = await this.resolveLeaveYearStartMonth(orgId);
      if (yearStartMonth === currentMonth) {
        const result = await this.resetYearlyLeaveBalances(orgId, now.getFullYear());
        totalResetCount += result.resetCount;
        yearlyReset = { resetCount: totalResetCount };
      }
    }

    return { monthlyExpiry, yearlyReset };
  }

  private async resolveLeaveYearStartMonth(orgId: string): Promise<number> {
    const orgPolicy = await this.db.query.leavePolicies.findFirst({
      where: and(eq(leavePolicies.orgId, orgId), eq(leavePolicies.isActive, true)),
      columns: { accrualType: true },
    });
    if (!orgPolicy) return 1;
    return 1;
  }

  private async expireUnusedMonthlyLeaves(): Promise<{ expiredCount: number }> {
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
      .where(and(eq(leavePolicies.accrualType, "MONTHLY"), eq(leavePolicies.isActive, true)));

    if (monthlyPolicies.length === 0) return { expiredCount: 0 };

    const monthlyLeaveTypeIds = monthlyPolicies.map((p) => p.leaveTypeId);
    const policyByTypeId = new Map(monthlyPolicies.map((p) => [p.leaveTypeId, p]));

    const positiveBalances = await this.db.query.leaveBalances.findMany({
      where: and(
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

  private async resetYearlyLeaveBalances(
    orgId: string,
    newYear: number,
  ): Promise<{ resetCount: number }> {
    const types = await this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      columns: { id: true, name: true, daysPerYear: true, carryForward: true },
    });

    const members = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
      columns: { userId: true },
      with: { user: { columns: { id: true, joiningDate: true, isActive: true } } },
    });

    const activeMembers = members.filter((m) => m.user?.isActive);
    if (activeMembers.length === 0 || types.length === 0) return { resetCount: 0 };

    const prevYear = newYear - 1;
    const prevYearBalances = await this.db.query.leaveBalances.findMany({
      where: and(eq(leaveBalances.orgId, orgId), eq(leaveBalances.year, prevYear)),
      columns: { userId: true, leaveTypeId: true, balance: true },
    });
    const prevBalMap = new Map<string, number>();
    for (const b of prevYearBalances) {
      prevBalMap.set(`${b.userId}:${b.leaveTypeId}`, Number(b.balance));
    }

    const existingNewYear = await this.db.query.leaveBalances.findMany({
      where: and(eq(leaveBalances.orgId, orgId), eq(leaveBalances.year, newYear)),
      columns: { userId: true, leaveTypeId: true },
    });
    const existingSet = new Set(existingNewYear.map((b) => `${b.userId}:${b.leaveTypeId}`));

    const toInsertBalances: (typeof leaveBalances.$inferInsert)[] = [];
    const ledgerEntries: (typeof hrLeaveLedger.$inferInsert)[] = [];
    const yearStartDate = `${newYear}-01-01`;

    for (const member of activeMembers) {
      const joiningDate = member.user?.joiningDate ? new Date(member.user.joiningDate) : new Date();
      for (const type of types) {
        if (existingSet.has(`${member.userId}:${type.id}`)) continue;

        const proratedBalance = this.calculateInitialBalance(type.daysPerYear, joiningDate, newYear);
        let carryForwardDays = 0;
        if (type.carryForward) {
          carryForwardDays = prevBalMap.get(`${member.userId}:${type.id}`) ?? 0;
        }
        const totalBalance = proratedBalance + carryForwardDays;

        toInsertBalances.push({
          orgId,
          userId: member.userId,
          leaveTypeId: type.id,
          year: newYear,
          balance: totalBalance.toString(),
        });

        ledgerEntries.push({
          orgId,
          userId: member.userId,
          leaveTypeId: type.id,
          txnType: "accrual",
          days: String(proratedBalance),
          effectiveDate: yearStartDate,
          period: String(newYear),
          source: "cron",
          note: "Yearly leave reset accrual",
          payrollStatus: "pending",
        });

        if (carryForwardDays > 0) {
          ledgerEntries.push({
            orgId,
            userId: member.userId,
            leaveTypeId: type.id,
            txnType: "carry_forward",
            days: String(carryForwardDays),
            effectiveDate: yearStartDate,
            period: String(newYear),
            source: "cron",
            note: `Carry forward from ${prevYear}`,
            payrollStatus: "pending",
          });
        }
      }
    }

    let resetCount = 0;
    if (toInsertBalances.length > 0) {
      await this.db.transaction(async (tx) => {
        await tx.insert(leaveBalances).values(toInsertBalances).onConflictDoNothing();
        if (ledgerEntries.length > 0) {
          await tx.insert(hrLeaveLedger).values(ledgerEntries);
        }
      });
      resetCount = toInsertBalances.length;
    }

    return { resetCount };
  }

  private calculateInitialBalance(daysPerYear: number, joiningDate: Date, year: number): number {
    const joinYear = joiningDate.getFullYear();
    if (joinYear > year) return 0;
    if (joinYear < year) return daysPerYear;
    const monthsRemaining = 12 - joiningDate.getMonth();
    return Math.round((daysPerYear / 12) * monthsRemaining * 10) / 10;
  }
}
