import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  hrLeaveLedger,
  leaveBalances,
  leavePolicies,
  leaveTypes,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmploymentFactsService } from "../directory/employment-facts.service";

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class CronLeaveResetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async resolveLeaveYearStartMonth(orgId: string): Promise<number> {
    const orgPolicy = await this.db.query.leavePolicies.findFirst({
      where: and(
        eq(leavePolicies.orgId, orgId),
        eq(leavePolicies.isActive, true),
        eq(leavePolicies.accrualType, "ANNUAL"),
      ),
      columns: { effectiveFrom: true },
    });
    if (!orgPolicy?.effectiveFrom) return 1;
    const month = Number(String(orgPolicy.effectiveFrom).slice(5, 7));
    return Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
  }

  async resetYearlyLeaveBalances(
    orgId: string,
    newYear: number,
  ): Promise<{ resetCount: number }> {
    const annualPolicies = await this.db
      .select({
        leaveTypeId: leavePolicies.leaveTypeId,
        accrualRate: leavePolicies.accrualRate,
        carryForwardDays: leavePolicies.carryForwardDays,
        maxBalance: leavePolicies.maxBalance,
      })
      .from(leavePolicies)
      .where(
        and(
          eq(leavePolicies.orgId, orgId),
          eq(leavePolicies.isActive, true),
          eq(leavePolicies.accrualType, "ANNUAL"),
        ),
      );

    if (annualPolicies.length === 0) return { resetCount: 0 };

    const types = await this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      columns: { id: true, name: true, daysPerYear: true, carryForward: true },
    });
    const typeById = new Map(types.map((t) => [t.id, t]));

    const members = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
      columns: { userId: true },
      with: { user: { columns: { id: true, isActive: true } } },
    });

    const activeMembers = members.filter((m) => m.user?.isActive);
    if (activeMembers.length === 0) return { resetCount: 0 };

    const joiningFacts = await this.employmentFacts.getFactsBatch(
      orgId,
      activeMembers.map((m) => m.userId),
    );

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
      const memberJoiningDate = joiningFacts.get(member.userId)?.joiningDate;
      const joiningDate = memberJoiningDate ? new Date(memberJoiningDate) : new Date();
      for (const policy of annualPolicies) {
        if (existingSet.has(`${member.userId}:${policy.leaveTypeId}`)) continue;

        const type = typeById.get(policy.leaveTypeId);
        const annualDays = Number(policy.accrualRate);
        if (!Number.isFinite(annualDays) || annualDays <= 0) continue;

        const proratedBalance = this.calculateInitialBalance(annualDays, joiningDate, newYear);
        let carryForwardDays = 0;
        const maxCarry = Number(policy.carryForwardDays ?? 0);
        if (maxCarry > 0 || type?.carryForward) {
          const prev = prevBalMap.get(`${member.userId}:${policy.leaveTypeId}`) ?? 0;
          carryForwardDays = maxCarry > 0 ? Math.min(prev, maxCarry) : prev;
        }

        let totalBalance = proratedBalance + carryForwardDays;
        if (policy.maxBalance != null) {
          const max = Number(policy.maxBalance);
          if (Number.isFinite(max)) totalBalance = Math.min(totalBalance, max);
        }

        toInsertBalances.push({
          orgId,
          userId: member.userId,
          leaveTypeId: policy.leaveTypeId,
          year: newYear,
          balance: totalBalance.toFixed(2),
        });

        ledgerEntries.push({
          orgId,
          userId: member.userId,
          leaveTypeId: policy.leaveTypeId,
          txnType: "accrual",
          days: String(proratedBalance),
          effectiveDate: yearStartDate,
          period: String(newYear),
          source: "cron",
          note: "Yearly leave reset accrual from leave_policies",
          payrollStatus: "pending",
        });

        if (carryForwardDays > 0) {
          ledgerEntries.push({
            orgId,
            userId: member.userId,
            leaveTypeId: policy.leaveTypeId,
            txnType: "carry_forward",
            days: String(carryForwardDays),
            effectiveDate: yearStartDate,
            period: String(newYear),
            source: "cron",
            note: `Carry forward from ${prevYear} (policy max ${maxCarry || "type default"})`,
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
