import { ConflictException, Injectable, Inject } from "@nestjs/common";
import { and, asc, eq, gte, lte, count } from "drizzle-orm";
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
import {
  normalizePayrollToggles,
  toPayrollPolicyConfig,
} from "../dto/payroll.schemas";
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
    const month =
      query.month ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const runs = await this.db
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.month, month),
          eq(payrollRuns.runType, "REGULAR"),
        ),
      )
      .limit(1);

    const run = runs[0] ?? null;

    const in14Days = new Date(now);
    in14Days.setDate(in14Days.getDate() + 14);
    const todayStr = now.toISOString().slice(0, 10);
    const in14DaysStr = in14Days.toISOString().slice(0, 10);

    const [versionData, policyRows, upcomingCalendarEvents] = await Promise.all(
      [
        run?.policyVersionId
          ? this.loadVersionData(orgId, run.policyVersionId)
          : Promise.resolve(null),
        this.db
          .select({ country: payrollPolicies.country })
          .from(payrollPolicies)
          .where(eq(payrollPolicies.orgId, orgId))
          .limit(1),
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
          .orderBy(payrollCalendarEvents.date)
          .limit(101),
      ],
    );

    if (upcomingCalendarEvents.length > 100) {
      throw new ConflictException(
        "Upcoming payroll calendar exceeds the supported 100-event window bound",
      );
    }

    const toggles = versionData?.toggles ?? null;
    const packComplianceChecklist = this.buildPackComplianceChecklist(
      policyRows[0]?.country ?? "IN",
      versionData?.config ?? null,
    );

    const [
      checklist,
      varianceSummary,
      exceptionCounts,
      topExceptions,
      pendingApprovals,
    ] = await Promise.all([
      run
        ? buildRunChecklist(this.db, orgId, run, toggles)
        : Promise.resolve([]),
      run
        ? this.runsService.buildVarianceSummary(
            orgId,
            run.id,
            run.month,
            run.netTotal,
          )
        : Promise.resolve(null),
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
            .where(
              and(
                eq(payrollExceptions.orgId, orgId),
                eq(payrollExceptions.runId, run.id),
                eq(payrollExceptions.status, "OPEN"),
              ),
            )
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
            .where(
              and(
                eq(payrollApprovals.orgId, orgId),
                eq(payrollApprovals.runId, run.id),
                eq(payrollApprovals.status, "PENDING"),
              ),
            )
            .orderBy(asc(payrollApprovals.stage))
            .limit(21)
        : Promise.resolve([]),
    ]);

    if (pendingApprovals.length > 20) {
      throw new ConflictException(
        "Payroll approval workflow exceeds the supported 20-stage bound",
      );
    }

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
      : {
          runId: null,
          month,
          status: null,
          grossTotal: "0",
          deductionTotal: "0",
          netTotal: "0",
          employerCostTotal: "0",
          employeeCount: 0,
          exceptionCounts,
        };

    return {
      header,
      checklist,
      panels: {
        runStatus: run?.status ?? null,
        topExceptions,
        varianceSummary,
        pendingApprovals,
        payoutReadiness: run
          ? ["LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"].includes(
              run.status,
            )
          : false,
        statutoryReadiness: {
          taxDeclarationsLocked:
            checklist.find((c) => c.key === "tax_declarations_locked")?.done ??
            false,
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
      .where(
        and(
          eq(payrollExceptions.runId, runId),
          eq(payrollExceptions.orgId, orgId),
          eq(payrollExceptions.status, "OPEN"),
        ),
      )
      .groupBy(payrollExceptions.severity);

    const result = { BLOCKER: 0, WARNING: 0, INFO: 0 };
    for (const row of rows) {
      result[row.severity] = Number(row.total);
    }
    return result;
  }

  private async loadVersionData(
    orgId: string,
    policyVersionId: number,
  ): Promise<{
    toggles: PayrollToggles | null;
    config: PayrollPolicyConfig | null;
  }> {
    const version = await this.db
      .select({
        toggles: payrollPolicyVersions.toggles,
        config: payrollPolicyVersions.config,
      })
      .from(payrollPolicyVersions)
      .where(
        and(
          eq(payrollPolicyVersions.id, policyVersionId),
          eq(payrollPolicyVersions.orgId, orgId),
        ),
      )
      .limit(1);

    const rawToggles = version[0]?.toggles;
    return {
      toggles:
        rawToggles && typeof rawToggles === "object"
          ? normalizePayrollToggles(rawToggles)
          : null,
      config: toPayrollPolicyConfig(version[0]?.config),
    };
  }

  private buildPackComplianceChecklist(
    country: string,
    config: PayrollPolicyConfig | null,
  ): { key: string; label: string; detail: string }[] {
    if (country === "IN") return [];
    const packCountry = config?.statutoryPack?.country ?? country;
    return getStatutoryPack(packCountry).complianceChecklist;
  }
}
