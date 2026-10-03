import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollRunEmployees, payrollRuns, users } from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES, type VarianceSummary } from "../payroll.types";
import { toCalculationSnapshot } from "../dto/payroll.schemas";
import { fromPaise, toPaise } from "./lib/money";

@Injectable()
export class PayrollRunVarianceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getVariance(orgId: string, runId: number) {
    const run = await this.db
      .select({ id: payrollRuns.id, month: payrollRuns.month, grossTotal: payrollRuns.grossTotal, netTotal: payrollRuns.netTotal })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) return null;

    const prevRun = await this.db
      .select({ id: payrollRuns.id, month: payrollRuns.month, grossTotal: payrollRuns.grossTotal, netTotal: payrollRuns.netTotal })
      .from(payrollRuns)
      .where(and(
        eq(payrollRuns.orgId, orgId),
        sql`${payrollRuns.month} < ${run[0].month}`,
        inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
      ))
      .orderBy(desc(payrollRuns.month))
      .limit(1);

    const topMovers = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        net: payrollRunEmployees.net,
        userName: users.name,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
        paidDays: payrollRunEmployees.paidDays,
        lopDays: payrollRunEmployees.lopDays,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
      .orderBy(
        sql`abs(coalesce(nullif(${payrollRunEmployees.calculationSnapshot} -> 'variance' ->> 'netDeltaPercent', '')::numeric, 0)) desc`,
        desc(payrollRunEmployees.net),
      )
      .limit(10);

    const withBaselines = topMovers.map((m) => {
      const snap = toCalculationSnapshot(m.calculationSnapshot);
      return {
        userId: m.userId,
        net: m.net,
        userName: m.userName,
        paidDays: m.paidDays,
        lopDays: m.lopDays,
        baselineSource: snap?.variance?.baselineSource ?? (prevRun[0] ? "PREVIOUS_RUN" : null),
        inputBaseline: snap?.variance?.inputBaseline ?? null,
        netDeltaPercent: snap?.variance?.netDeltaPercent ?? null,
      };
    });

    return {
      currentRun: run[0],
      previousRun: prevRun[0] ?? null,
      topMovers: withBaselines,
      lockedInputBaselinesUsed: withBaselines.some(
        (m) => m.baselineSource === "LOCKED_INPUT_SNAPSHOT" || m.baselineSource === "PREVIOUS_RUN_AND_LOCKED_INPUTS",
      ),
    };
  }

  async buildSummary(
    orgId: string,
    runId: number,
    currentMonth: string,
    currentNetTotal: string | null,
  ): Promise<VarianceSummary | null> {
    const [[prevRun], currentEmps] = await Promise.all([
      this.db
        .select({ id: payrollRuns.id, month: payrollRuns.month, netTotal: payrollRuns.netTotal })
        .from(payrollRuns)
        .where(and(
          eq(payrollRuns.orgId, orgId),
          lt(payrollRuns.month, currentMonth),
          inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
        ))
        .orderBy(desc(payrollRuns.month))
        .limit(1),
      this.db
        .select({ userId: payrollRunEmployees.userId, net: payrollRunEmployees.net })
        .from(payrollRunEmployees)
        .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
        .limit(1000),
    ]);

    if (!prevRun) return null;

    const prevEmps = await this.db
      .select({ userId: payrollRunEmployees.userId, net: payrollRunEmployees.net })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, prevRun.id), eq(payrollRunEmployees.orgId, orgId)))
      .limit(1000);

    const currentUserIds = new Set(currentEmps.map((employee) => employee.userId));
    const prevNetMap = new Map(prevEmps.map((employee) => [employee.userId, employee.net]));
    const newJoiners = currentEmps.filter((employee) => !prevNetMap.has(employee.userId)).length;
    const exited = prevEmps.filter((employee) => !currentUserIds.has(employee.userId)).length;
    const changedEmployees = currentEmps.filter((employee) => {
      const prevNet = prevNetMap.get(employee.userId);
      return prevNet != null && prevNet !== employee.net;
    }).length;

    const currentNetPaise = toPaise(currentNetTotal ?? "0");
    const prevNetPaise = toPaise(prevRun.netTotal ?? "0");
    const netDeltaPaise = currentNetPaise - prevNetPaise;
    const netDeltaPercent = prevNetPaise !== 0 ? (netDeltaPaise / prevNetPaise) * 100 : 0;

    return {
      previousMonth: prevRun.month,
      currentNet: (currentNetPaise / 100).toFixed(2),
      previousNet: (prevNetPaise / 100).toFixed(2),
      netDelta: fromPaise(netDeltaPaise),
      netDeltaPercent: Math.round(netDeltaPercent * 100) / 100,
      newJoiners,
      exited,
      changedEmployees,
    };
  }
}
