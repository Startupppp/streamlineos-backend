import { asRecord } from "../../../../common/openapi/zod-operation-contracts";

export interface PayrollOrgDefaults {
  professionalTaxMonthly: number;
  standardWorkingDaysPerMonth: number;
  workWeekDays: number[];
  lopBasis: "calendar" | "working";
  defaultBasicPercent: number;
  defaultHraPercent: number;
  defaultAllowancePercent: number;
}

export const SEEDED_PAYROLL_DEFAULTS: PayrollOrgDefaults = {
  professionalTaxMonthly: 200,
  standardWorkingDaysPerMonth: 22,
  workWeekDays: [1, 2, 3, 4, 5],
  lopBasis: "calendar",
  defaultBasicPercent: 50,
  defaultHraPercent: 50,
  defaultAllowancePercent: 25,
};

function extractFromConfig(config: unknown): Partial<PayrollOrgDefaults> {
  const c = asRecord(config);
  if (!c) return {};

  const result: Partial<PayrollOrgDefaults> = {};

  const s = asRecord(c["statutory"]);
  if (s) {
    const pt = parseFloat(String(s["professionalTaxMonthly"] ?? ""));
    if (isFinite(pt) && pt >= 0) result.professionalTaxMonthly = pt;

    const basicPct = parseFloat(String(s["defaultBasicPercent"] ?? ""));
    if (isFinite(basicPct) && basicPct > 0) result.defaultBasicPercent = basicPct;

    const hraPct = parseFloat(String(s["defaultHraPercent"] ?? ""));
    if (isFinite(hraPct) && hraPct >= 0) result.defaultHraPercent = hraPct;

    const allowPct = parseFloat(String(s["defaultAllowancePercent"] ?? ""));
    if (isFinite(allowPct) && allowPct >= 0) result.defaultAllowancePercent = allowPct;
  }

  const o = asRecord(c["orgConfig"]);
  if (o) {
    const stdDays = Number(o["standardWorkingDaysPerMonth"]);
    if (isFinite(stdDays) && stdDays > 0) result.standardWorkingDaysPerMonth = stdDays;

    if (Array.isArray(o["workWeekDays"])) {
      const days = o["workWeekDays"]
        .map(Number)
        .filter((d) => isFinite(d) && d >= 0 && d <= 6);
      if (days.length > 0) result.workWeekDays = days;
    }

    const lopBasis = o["lopBasis"];
    if (lopBasis === "calendar" || lopBasis === "working") result.lopBasis = lopBasis;
  }

  return result;
}

export function resolvePayrollDefaults(policyConfig: unknown): PayrollOrgDefaults {
  const overrides = extractFromConfig(policyConfig);
  return { ...SEEDED_PAYROLL_DEFAULTS, ...overrides };
}

export function countWorkingDays(
  year: number,
  month: number,
  workWeekDays: number[],
): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  const workSet = new Set(workWeekDays);
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (workSet.has(dow)) count++;
  }
  return count;
}
