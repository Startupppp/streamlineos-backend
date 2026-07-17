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
  payrollPolicies,
} from "../../../db/schema";
import { buildRunChecklist } from "./lib/checklist";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import type { PayrollToggles, PayrollPolicyConfig } from "../payroll.types";
import { getStatutoryPack } from "./lib/statutory-packs";
import type { CommandCenterQuery } from "./dto/runs.schemas";
import { RunsService } from "./runs.service";

@Injectable()
export class CommandCenterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly runsService: RunsService,
  ) {}

  async getCommandCenter(orgId: string, query: CommandCenterQuery) {
    const now = new Date();
    const month = query.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const runs = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.month, month)))
      .limit(1);

    const run = runs[0] ?? null;

    const in14Days = new Date(now);
    in14Days.setDate(in14Days.getDate() + 14);
    const todayStr = now.toISOString().slice(0, 10);
    const in14DaysStr = in14Days.toISOString().slice(0, 10);

    const [toggles, packComplianceChecklist, upcomingCalendarEvents] = await Promise.all([
      run?.policyVersionId ? this.loadToggles(orgId, run.policyVersionId) : Promise.resolve(null),
      this.loadPackComplianceChecklist(orgId, run?.policyVersionId ?? null),
      this.db
        .select()
        .from(payrollCalendarEvents)
        .where(
          and(
            eq(payrollCalendarEvents.orgId, orgId),
            gte(payrollCalendarEvents.date, todayStr),
            lte(payrollCalendarEvents.date, in14DaysStr),
          ),
        )
        .orderBy(payrollCalendarEvents.date),
    ]);

    const checklist = run ? await buildRunChecklist(this.db, orgId, run, toggles) : [];

    const [exceptionCounts, topExceptions, pendingApprovals] = await Promise.all([
      run
        ? this.getExceptionCounts(orgId, run.id)
        : Promise.resolve({ BLOCKER: 0, WARNING: 0, INFO: 0 }),
      run
        ? this.db
            .select({
              id: payrollExceptions.id,
              runEmployeeId: payrollExceptions.runEmployeeId,
              userId: payrollExceptions.userId,
              code: payrollExceptions.code,
              severity: payrollExceptions.severity,
              message: payrollExceptions.message,
              status: payrollExceptions.status,
            })
            .from(payrollExceptions)
            .where(and(eq(payrollExceptions.runId, run.id), eq(payrollExceptions.status, "OPEN")))
            .orderBy(payrollExceptions.severity)
            .limit(5)
        : Promise.resolve([]),
      run
        ? this.db
            .select({
              id: payrollApprovals.id,
              stage: payrollApprovals.stage,
              status: payrollApprovals.status,
            })
            .from(payrollApprovals)
            .where(and(eq(payrollApprovals.runId, run.id), eq(payrollApprovals.status, "PENDING")))
        : Promise.resolve([]),
    ]);

    const header = run
      ? {
          runId: run.id,
          month: run.month,
          status: run.status,
          grossTotal: run.grossTotal,
          deductionTotal: run.deductionTotal,
          netTotal: run.netTotal,
          employerCostTotal: run.employerCostTotal,
          employeeCount: run.employeeCount,
          exceptionCounts,
        }
      : { runId: null, month, status: null, grossTotal: "0", deductionTotal: "0", netTotal: "0", employerCostTotal: "0", employeeCount: 0, exceptionCounts };

    return {
      header,
      checklist,
      panels: {
        runStatus: run?.status ?? null,
        topExceptions,
        varianceSummary: run
          ? await this.runsService.buildVarianceSummary(orgId, run.id, run.month, run.netTotal)
          : null,
        pendingApprovals,
        payoutReadiness: run ? ["LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"].includes(run.status) : false,
        statutoryReadiness: {
          taxDeclarationsLocked: checklist.find((c) => c.key === "tax_declarations_locked")?.done ?? false,
          packComplianceChecklist,
        },
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

    const raw = version[0]?.toggles;
    return raw && typeof raw === "object" ? { ...DEFAULT_PAYROLL_TOGGLES, ...(raw as Partial<PayrollToggles>) } : null;
  }

  private async loadPackComplianceChecklist(
    orgId: string,
    policyVersionId: number | null,
  ): Promise<{ key: string; label: string; detail: string }[]> {
    const policy = await this.db
      .select({ country: payrollPolicies.country })
      .from(payrollPolicies)
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    const country = policy[0]?.country ?? "IN";
    if (country === "IN") return [];

    if (policyVersionId != null) {
      const version = await this.db
        .select({ config: payrollPolicyVersions.config })
        .from(payrollPolicyVersions)
        .where(and(eq(payrollPolicyVersions.id, policyVersionId), eq(payrollPolicyVersions.orgId, orgId)))
        .limit(1);

      const rawConfig = version[0]?.config;
      const config: PayrollPolicyConfig | null = rawConfig && typeof rawConfig === "object" ? (rawConfig as PayrollPolicyConfig) : null;
      const packCountry = config?.statutoryPack?.country ?? country;
      return getStatutoryPack(packCountry).complianceChecklist;
    }

    return getStatutoryPack(country).complianceChecklist;
  }
}
