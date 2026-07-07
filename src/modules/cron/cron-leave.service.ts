import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { leaveBalances, leaveRequests, leaveTypes, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { DEFAULT_LEAVE_TYPES, LEAVE_POLICY, resolveInitialBalance } from "./cron-leave-policy";

interface LeaveType {
  id: number;
  name: string;
  daysPerYear: number;
}

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class CronLeaveService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async runMonthlyLeaveReset(): Promise<{
    monthlyExpiry: { expiredCount: number };
    yearlyReset: { resetCount: number } | null;
  }> {
    const isJanuary = new Date().getMonth() === 0;
    const monthlyExpiry = await this.expireUnusedMonthlyCasualLeaves();
    const yearlyReset = isJanuary ? await this.resetYearlyLeaveBalances() : null;
    return { monthlyExpiry, yearlyReset };
  }

  private async ensureLeaveTypes(orgId: string): Promise<LeaveType[]> {
    const existing = await this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      columns: { id: true, name: true, daysPerYear: true },
    });

    const existingNames = new Set(existing.map((t) => t.name));
    for (const t of DEFAULT_LEAVE_TYPES) {
      if (!existingNames.has(t.name)) {
        await this.db.insert(leaveTypes).values({
          orgId,
          name: t.name,
          daysPerYear: t.daysPerYear,
          carryForward: t.carryForward,
        });
      }
    }

    return this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      columns: { id: true, name: true, daysPerYear: true },
    });
  }

  private async expireUnusedMonthlyCasualLeaves(): Promise<{ expiredCount: number }> {
    const now = new Date();
    const currentYear = now.getFullYear();
    const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const prevMonthYear = now.getMonth() === 0 ? currentYear - 1 : currentYear;
    const monthStartStr = toDateStr(new Date(prevMonthYear, prevMonth, 1));
    const monthEndStr = toDateStr(new Date(prevMonthYear, prevMonth + 1, 0));

    const casualTypes = await this.db.query.leaveTypes.findMany({
      where: eq(leaveTypes.name, LEAVE_POLICY.CASUAL.name),
      columns: { id: true, orgId: true },
    });
    if (casualTypes.length === 0) return { expiredCount: 0 };

    const orgCasualMap = new Map(casualTypes.map((ct) => [ct.orgId, ct]));
    const casualTypeIds = casualTypes.map((ct) => ct.id);

    const positiveBalances = await this.db.query.leaveBalances.findMany({
      where: and(
        inArray(leaveBalances.leaveTypeId, casualTypeIds),
        eq(leaveBalances.year, prevMonthYear),
        gt(leaveBalances.balance, "0"),
      ),
      columns: { id: true, orgId: true, userId: true, leaveTypeId: true, balance: true },
    });
    if (positiveBalances.length === 0) return { expiredCount: 0 };

    const usedLeaveResults = await this.db
      .select({
        userId: leaveRequests.userId,
        leaveTypeId: leaveRequests.leaveTypeId,
      })
      .from(leaveRequests)
      .where(
        and(
          inArray(leaveRequests.leaveTypeId, casualTypeIds),
          eq(leaveRequests.status, "APPROVED"),
          gte(leaveRequests.startDate, monthStartStr),
          lte(leaveRequests.endDate, monthEndStr),
        ),
      )
      .groupBy(leaveRequests.userId, leaveRequests.leaveTypeId);

    const usedSet = new Set(usedLeaveResults.map((r) => `${r.userId}:${r.leaveTypeId}`));

    let expiredCount = 0;
    for (const bal of positiveBalances) {
      const casualType = orgCasualMap.get(bal.orgId);
      if (!casualType || bal.leaveTypeId !== casualType.id) continue;

      if (!usedSet.has(`${bal.userId}:${bal.leaveTypeId}`)) {
        const newBalance = Math.max(0, Number(bal.balance) - LEAVE_POLICY.CASUAL.perMonth);
        await this.db
          .update(leaveBalances)
          .set({ balance: newBalance.toString() })
          .where(eq(leaveBalances.id, bal.id));
        expiredCount++;
      }
    }

    return { expiredCount };
  }

  private async resetYearlyLeaveBalances(): Promise<{ resetCount: number }> {
    const newYear = new Date().getFullYear();
    const orgs = await this.db.selectDistinct({ orgId: leaveTypes.orgId }).from(leaveTypes);

    let resetCount = 0;
    for (const { orgId } of orgs) {
      const types = await this.ensureLeaveTypes(orgId);
      const members = await this.db.query.organizationMembers.findMany({
        where: eq(organizationMembers.orgId, orgId),
        columns: { userId: true },
        with: { user: { columns: { id: true, joiningDate: true, isActive: true } } },
      });

      const activeMembers = members.filter((m) => m.user?.isActive);
      if (activeMembers.length === 0 || types.length === 0) continue;

      const existingBalances = await this.db.query.leaveBalances.findMany({
        where: and(eq(leaveBalances.orgId, orgId), eq(leaveBalances.year, newYear)),
        columns: { userId: true, leaveTypeId: true },
      });
      const existingSet = new Set(existingBalances.map((b) => `${b.userId}:${b.leaveTypeId}`));

      const toInsert: (typeof leaveBalances.$inferInsert)[] = [];
      for (const member of activeMembers) {
        const joiningDate = member.user?.joiningDate ? new Date(member.user.joiningDate) : new Date();
        for (const type of types) {
          if (existingSet.has(`${member.userId}:${type.id}`)) continue;
          const balance = resolveInitialBalance(type.name, type.daysPerYear, joiningDate, newYear);
          toInsert.push({
            orgId,
            userId: member.userId,
            leaveTypeId: type.id,
            year: newYear,
            balance: balance.toString(),
          });
        }
      }

      if (toInsert.length > 0) {
        await this.db.insert(leaveBalances).values(toInsert).onConflictDoNothing();
        resetCount += toInsert.length;
      }
    }

    return { resetCount };
  }
}
