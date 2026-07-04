import { Injectable, Inject } from "@nestjs/common";
import { and, eq, gte, lte, count, desc, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollExceptions,
  payrollApprovals,
  payrollCalendarEvents,
  payrollPolicyVersions,
} from "../../../db/schema";
import { buildRunChecklist } from "./lib/checklist";
import type { PayrollToggles } from "../payroll.types";
import type { CommandCenterQuery } from "./dto/runs.schemas";

@Injectable()
export class CommandCenterService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getCommandCenter(orgId: string, query: CommandCenterQuery) {
    const now = new Date();
    const month = query.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const runs = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.month, month)))
      .limit(1);

    const run = runs[0] ?? null;

    const toggles = run?.policyVersionId ? await this.loadToggles(orgId, run.policyVersionId) : null;
    const checklist = run ? await buildRunChecklist(this.db, orgId, run, toggles) : [];

    const exceptionCounts = run
      ? await this.getExceptionCounts(orgId, run.id)
      : { BLOCKER: 0, WARNING: 0, INFO: 0 };

    const topExceptions = run
      ? await this.db
          .select({
            id: payrollExceptions.id,
            code: payrollExceptions.code,
            severity: payrollExceptions.severity,
            message: payrollExceptions.message,
            status: payrollExceptions.status,
          })
          .from(payrollExceptions)
          .where(and(eq(payrollExceptions.runId, run.id), eq(payrollExceptions.status, "OPEN")))
          .orderBy(payrollExceptions.severity)
          .limit(5)
      : [];

    const pendingApprovals = run
      ? await this.db
          .select()
          .from(payrollApprovals)
          .where(and(eq(payrollApprovals.runId, run.id), eq(payrollApprovals.status, "PENDING")))
      : [];

    const in14Days = new Date(now);
    in14Days.setDate(in14Days.getDate() + 14);
    const todayStr = now.toISOString().slice(0, 10);
    const in14DaysStr = in14Days.toISOString().slice(0, 10);

    const upcomingCalendarEvents = await this.db
      .select()
      .from(payrollCalendarEvents)
      .where(
        and(
          eq(payrollCalendarEvents.orgId, orgId),
          gte(payrollCalendarEvents.date, todayStr),
          lte(payrollCalendarEvents.date, in14DaysStr),
        ),
      )
      .orderBy(payrollCalendarEvents.date);

    const header = run
      ? {
          month: run.month,
          status: run.status,
          grossTotal: run.grossTotal,
          deductionTotal: run.deductionTotal,
          netTotal: run.netTotal,
          employerCostTotal: run.employerCostTotal,
          employeeCount: run.employeeCount,
          exceptionCounts,
        }
      : { month, status: null, grossTotal: "0", deductionTotal: "0", netTotal: "0", employerCostTotal: "0", employeeCount: 0, exceptionCounts };

    return {
      header,
      checklist,
      panels: {
        runStatus: run?.status ?? null,
        topExceptions,
        varianceSummary: null,
        pendingApprovals,
        payoutReadiness: run ? ["LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"].includes(run.status) : false,
        statutoryReadiness: checklist.find((c) => c.key === "tax_declarations_locked")?.done ?? false,
      },
      upcomingCalendarEvents,
    };
  }

  private async getExceptionCounts(orgId: string, runId: number) {
    const rows = await this.db
      .select({
        severity: payrollExceptions.severity,
        total: count(),
      })
      .from(payrollExceptions)
      .where(and(eq(payrollExceptions.runId, runId), eq(payrollExceptions.orgId, orgId), eq(payrollExceptions.status, "OPEN")))
      .groupBy(payrollExceptions.severity);

    const result = { BLOCKER: 0, WARNING: 0, INFO: 0 };
    for (const row of rows) {
      result[row.severity] = Number(row.total);
    }
    return result;
  }

  private async loadToggles(orgId: string, policyVersionId: number): Promise<PayrollToggles | null> {
    const version = await this.db
      .select({ toggles: payrollPolicyVersions.toggles })
      .from(payrollPolicyVersions)
      .where(and(eq(payrollPolicyVersions.id, policyVersionId), eq(payrollPolicyVersions.orgId, orgId)))
      .limit(1);

    return (version[0]?.toggles as PayrollToggles) ?? null;
  }
}
