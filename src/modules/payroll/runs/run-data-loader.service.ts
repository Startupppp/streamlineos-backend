import { Injectable, Inject } from "@nestjs/common";
import { and, desc, eq, inArray, lt, lte, or, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  payrollRuns,
  payrollPolicies,
  payrollPolicyVersions,
  employeeSalaryProfiles,
  payrollRunEmployees,
  reimbursements,
  payrollRunAllocations,
} from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import {
  normalizePayrollToggles,
  toPayrollPolicyConfig,
  toCalculationSnapshot,
  toInputsSnapshot,
} from "../dto/payroll.schemas";
import type {
  PayrollToggles,
  PayrollPolicyConfig,
  CalculationSnapshot,
} from "../payroll.types";
import { DEFAULT_PAYROLL_POLICY_CONFIG } from "../setup/payroll-policy-defaults.constants";
import { payrollSubjectKey } from "../lib/payroll-subject";
import { requirePayrollUserIds } from "../lib/payroll-user-id";
import { PAYROLL_READ_CAP, requirePayrollReadWithinCap } from "../lib/query-bounds";
import { getLockedInputPeriodId } from "./lib/input-puller";
import type { ProfileData } from "./run-types";

@Injectable()
export class RunDataLoaderService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadPolicy(
    orgId: string,
    policyVersionId: number | null,
  ): Promise<{
    toggles: PayrollToggles;
    config: PayrollPolicyConfig;
    policyVersionId: number;
  } | null> {
    if (policyVersionId) {
      const version = await this.db
        .select()
        .from(payrollPolicyVersions)
        .where(
          and(
            eq(payrollPolicyVersions.id, policyVersionId),
            eq(payrollPolicyVersions.orgId, orgId),
          ),
        )
        .limit(1);

      if (version[0]) {
        return {
          toggles: normalizePayrollToggles(version[0].toggles),
          config: toPayrollPolicyConfig(version[0].config) ?? DEFAULT_PAYROLL_POLICY_CONFIG,
          policyVersionId: version[0].id,
        };
      }
    }

    const activeVersion = await this.db
      .select()
      .from(payrollPolicies)
      .innerJoin(
        payrollPolicyVersions,
        and(
          eq(payrollPolicyVersions.policyId, payrollPolicies.id),
          eq(payrollPolicyVersions.status, "ACTIVE"),
        ),
      )
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    if (!activeVersion[0]) return null;

    return {
      toggles: normalizePayrollToggles(activeVersion[0].payroll_policy_versions.toggles),
      config: toPayrollPolicyConfig(activeVersion[0].payroll_policy_versions.config) ?? DEFAULT_PAYROLL_POLICY_CONFIG,
      policyVersionId: activeVersion[0].payroll_policy_versions.id,
    };
  }

  async loadEligibleProfiles(
    orgId: string,
    month: string,
    toggles: PayrollToggles,
  ): Promise<ProfileData[]> {
    const [year, mon] = month.split("-").map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const monthEndDate = `${month}-${String(lastDay).padStart(2, "0")}`;

    // This set IS the payroll. A truncated read produced no exception, no
    // warning and no payroll_run_employees row for the payees it dropped, and
    // run-result-persister then wrote the short count into
    // payrollRuns.employeeCount, so the run looked internally consistent and
    // nobody found out until payday. The probe row turns an org above the bound
    // into a visible 409 instead; the ORDER BY makes the set the run covers
    // reproducible across a recalculation.
    const rows = requirePayrollReadWithinCap(
      await this.db
        .select({
          id: employeeSalaryProfiles.id,
          userId: employeeSalaryProfiles.userId,
          workerId: employeeSalaryProfiles.workerId,
          workerType: employeeSalaryProfiles.workerType,
          currency: employeeSalaryProfiles.currency,
          payoutCurrency: employeeSalaryProfiles.payoutCurrency,
          annualCtc: employeeSalaryProfiles.annualCtc,
          taxRegime: employeeSalaryProfiles.taxRegime,
        })
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            inArray(employeeSalaryProfiles.status, ["ACTIVE", "UPCOMING"]),
            lte(employeeSalaryProfiles.effectiveFrom, monthEndDate),
          ),
        )
        .orderBy(employeeSalaryProfiles.id)
        .limit(PAYROLL_READ_CAP + 1),
      "load eligible salary profiles",
    );

    const filtered = rows.filter((r) => r.id > 0);
    if (!toggles.contractorPayments)
      return filtered.filter((r) => r.workerType !== "CONTRACTOR");
    return filtered;
  }

  async loadHeldUserIds(
    orgId: string,
    runId: number,
    userIds: string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    // Same bound, same reason: a truncated hold list silently pays somebody the
    // operator deliberately held back.
    const rows = requirePayrollReadWithinCap(
      await this.db
        .select({ userId: payrollRunEmployees.userId })
        .from(payrollRunEmployees)
        .where(
          and(
            eq(payrollRunEmployees.orgId, orgId),
            eq(payrollRunEmployees.runId, runId),
            or(
              eq(payrollRunEmployees.status, "HELD"),
              isNotNull(payrollRunEmployees.holdReason),
            ),
          ),
        )
        .orderBy(payrollRunEmployees.id)
        .limit(PAYROLL_READ_CAP + 1),
      "load held payroll payees",
    );
    return new Set(requirePayrollUserIds(rows.map((r) => r.userId)));
  }

  async loadPreviousSnapshots(
    orgId: string,
    userIds: string[],
    currentMonth: string,
  ): Promise<Map<string, CalculationSnapshot>> {
    const result = new Map<string, CalculationSnapshot>();
    if (userIds.length === 0) return result;

    const [prevRun] = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
          lt(payrollRuns.month, currentMonth),
        ),
      )
      .orderBy(desc(payrollRuns.month))
      .limit(1);

    if (!prevRun) return result;

    const prevEmps = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
      })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.runId, prevRun.id),
          inArray(payrollRunEmployees.userId, userIds),
        ),
      )
      .limit(1000);

    for (const prevEmp of prevEmps) {
      if (!prevEmp.userId || result.has(prevEmp.userId)) continue;
      const snap = toCalculationSnapshot(prevEmp.calculationSnapshot);
      if (snap) result.set(prevEmp.userId, snap);
    }
    return result;
  }

  async clearPreviouslyConsumedReimbursements(
    orgId: string,
    runId: number,
  ): Promise<void> {
    const existingEmps = await this.db
      .select({ inputsSnapshot: payrollRunEmployees.inputsSnapshot })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.runId, runId),
          eq(payrollRunEmployees.orgId, orgId),
        ),
      )
      .limit(1000);

    const prevIds = existingEmps.flatMap(
      (e) => toInputsSnapshot(e.inputsSnapshot)?.consumedReimbursementIds ?? [],
    );

    if (prevIds.length > 0) {
      await this.db
        .update(reimbursements)
        .set({ paidAt: null })
        .where(
          and(
            inArray(reimbursements.id, prevIds),
            eq(reimbursements.orgId, orgId),
          ),
        );
    }
  }

  async clearRunAllocations(orgId: string, runId: number): Promise<void> {
    await this.db
      .delete(payrollRunAllocations)
      .where(
        and(
          eq(payrollRunAllocations.orgId, orgId),
          eq(payrollRunAllocations.runId, runId),
        ),
      );
  }

  async getLockedInputPeriodId(
    orgId: string,
    month: string,
  ): Promise<number | null> {
    return getLockedInputPeriodId(this.db, orgId, month);
  }
}
