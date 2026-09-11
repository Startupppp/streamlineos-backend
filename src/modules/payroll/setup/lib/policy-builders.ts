import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { payrollPolicies, payrollCalendarEvents } from "../../../../db/schema";
import type {
  PayrollToggles,
  PayrollPolicyConfig,
  TemplateComponentDef,
  PayrollApprovalStageDef,
  PayrollToggleKey,
  StatutoryPackConfig,
} from "../../payroll.types";
import { getStatutoryPack } from "../../runs/lib/statutory-packs";
import { addDays, format } from "date-fns";
import {
  DEFAULT_PAYROLL_CALENDAR as DEFAULT_CALENDAR,
  DEFAULT_PAYROLL_STATUTORY as DEFAULT_STATUTORY,
} from "../payroll-policy-defaults.constants";
import type { ActivatePolicyInput } from "../dto/setup.schemas";

export const RISKY_TOGGLES = new Set<PayrollToggleKey>([
  "pf",
  "esi",
  "professionalTax",
  "tds",
  "gratuity",
  "lwf",
  "approvalWorkflow",
  "lockAfterApproval",
]);

export const TOGGLE_STATUTORY_CODES: Partial<Record<PayrollToggleKey, string[]>> = {
  pf: ["PF_EMP", "PF_ER"],
  esi: ["ESI_EMP", "ESI_ER"],
  professionalTax: ["PT"],
  tds: ["TDS"],
  gratuity: ["GRATUITY_ER"],
  lwf: ["LWF"],
};

export function buildApprovalChain(toggles: PayrollToggles): PayrollApprovalStageDef[] {
  if (!toggles.approvalWorkflow) return [];
  const chain: PayrollApprovalStageDef[] = [];
  let stage = 1;
  if (toggles.managerApproval) {
    chain.push({
      stage,
      stageName: "Manager Review",
      requiredPermission: "payroll:runs:approve",
    });
    stage += 1;
  }
  chain.push({
    stage,
    stageName: "Payroll Admin Approval",
    requiredPermission: "payroll:runs:approve",
  });
  stage += 1;
  if (toggles.financeApproval) {
    chain.push({
      stage,
      stageName: "Finance Approval",
      requiredPermission: "payroll:runs:approve",
    });
  }
  return chain;
}

export function calendarEventsForMonth(
  policyId: number,
  orgId: string,
  startMonth: string,
  calendar: PayrollPolicyConfig["calendar"],
  payDay: number,
): Array<typeof payrollCalendarEvents.$inferInsert> {
  const [year, month] = startMonth.split("-").map(Number);
  const base = new Date(year, month - 1, 1);
  const nextMonthBase = new Date(year, month, 1);

  function dayOfMonth(day: number, ref: Date): Date {
    const d = new Date(ref);
    d.setDate(day);
    return d;
  }

  return [
    {
      orgId,
      policyId,
      month: startMonth,
      type: "ATTENDANCE_CUTOFF",
      date: format(dayOfMonth(calendar.attendanceCutoffDay, base), "yyyy-MM-dd"),
      title: "Attendance Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "REIMBURSEMENT_CUTOFF",
      date: format(dayOfMonth(calendar.reimbursementCutoffDay, base), "yyyy-MM-dd"),
      title: "Reimbursement Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "DECLARATION_CUTOFF",
      date: format(dayOfMonth(calendar.declarationCutoffDay, base), "yyyy-MM-dd"),
      title: "Tax Declaration Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PREVIEW_DUE",
      date: format(dayOfMonth(calendar.previewDay, base), "yyyy-MM-dd"),
      title: "Payroll Preview Due",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "APPROVAL_DEADLINE",
      date: format(dayOfMonth(calendar.approvalDeadlineDay, base), "yyyy-MM-dd"),
      title: "Approval Deadline",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PAY_DATE",
      date: format(dayOfMonth(payDay, nextMonthBase), "yyyy-MM-dd"),
      title: "Pay Date",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PUBLISH_DATE",
      date: format(
        addDays(dayOfMonth(payDay, nextMonthBase), calendar.publishOffsetDays),
        "yyyy-MM-dd",
      ),
      title: "Payslip Publish Date",
    },
  ];
}

export function buildPackConfig(country: string): StatutoryPackConfig {
  const pack = getStatutoryPack(country);
  return {
    country,
    items: pack.items.map((item) => ({
      key: item.key,
      enabled: item.enabledByDefault,
    })),
  };
}

export function buildDefaultConfig(
  input: ActivatePolicyInput,
  components: TemplateComponentDef[],
  toggles: PayrollToggles,
  country: string,
): PayrollPolicyConfig {
  const approvalChain = buildApprovalChain(toggles);
  const calendar = input.calendar ?? DEFAULT_CALENDAR;
  const statutory = input.statutory ?? DEFAULT_STATUTORY;
  const cfg: PayrollPolicyConfig = {
    components,
    rounding: { mode: "NEAREST", precision: 2 },
    approvalChain,
    payslipLayout: input.payslipLayout,
    calendar: {
      attendanceCutoffDay: calendar.attendanceCutoffDay ?? DEFAULT_CALENDAR.attendanceCutoffDay,
      reimbursementCutoffDay: calendar.reimbursementCutoffDay ?? DEFAULT_CALENDAR.reimbursementCutoffDay,
      declarationCutoffDay: calendar.declarationCutoffDay ?? DEFAULT_CALENDAR.declarationCutoffDay,
      previewDay: calendar.previewDay ?? DEFAULT_CALENDAR.previewDay,
      approvalDeadlineDay: calendar.approvalDeadlineDay ?? DEFAULT_CALENDAR.approvalDeadlineDay,
      publishOffsetDays: calendar.publishOffsetDays ?? DEFAULT_CALENDAR.publishOffsetDays,
    },
    statutory: {
      pfEmployeePercent: statutory.pfEmployeePercent ?? DEFAULT_STATUTORY.pfEmployeePercent,
      pfEmployerPercent: statutory.pfEmployerPercent ?? DEFAULT_STATUTORY.pfEmployerPercent,
      pfWageCeiling: statutory.pfWageCeiling ?? DEFAULT_STATUTORY.pfWageCeiling,
      esiEmployeePercent: statutory.esiEmployeePercent ?? DEFAULT_STATUTORY.esiEmployeePercent,
      esiEmployerPercent: statutory.esiEmployerPercent ?? DEFAULT_STATUTORY.esiEmployerPercent,
      esiWageCeiling: statutory.esiWageCeiling ?? DEFAULT_STATUTORY.esiWageCeiling,
      professionalTaxMonthly: statutory.professionalTaxMonthly ?? DEFAULT_STATUTORY.professionalTaxMonthly,
      tdsMode: statutory.tdsMode ?? DEFAULT_STATUTORY.tdsMode,
      tdsFlatPercent: statutory.tdsFlatPercent ?? null,
    },
    overtime: { multiplier: "1.50", basis: "BASIC" },
    varianceThresholdPercent: 20,
  };
  if (country !== "IN") {
    cfg.statutoryPack = buildPackConfig(country);
  }
  return cfg;
}

export async function assertBelongsToOrg(db: Db, orgId: string, policyId: number) {
  const policy = await db.query.payrollPolicies.findFirst({
    where: and(
      eq(payrollPolicies.id, policyId),
      eq(payrollPolicies.orgId, orgId),
    ),
  });
  if (!policy) throw new NotFoundException("Payroll policy not found");
  return policy;
}
