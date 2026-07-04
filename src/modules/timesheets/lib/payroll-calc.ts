import { payrollMappingSchema, type PayrollMapping } from "../dto/payroll.schemas";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resolveMapping(raw: unknown): PayrollMapping {
  if (raw === null || raw === undefined) return DEFAULT_PAYROLL_MAPPING;
  const parsed = payrollMappingSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_PAYROLL_MAPPING;
}

export function computeLeaveDays(
  leaves: Array<{ userId: string; startDate: string; endDate: string; isHalfDay: boolean }>,
  periodStart: string,
  periodEnd: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const lr of leaves) {
    const start = lr.startDate > periodStart ? lr.startDate : periodStart;
    const end = lr.endDate < periodEnd ? lr.endDate : periodEnd;
    if (end < start) continue;
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000 + 1;
    result.set(lr.userId, (result.get(lr.userId) ?? 0) + (lr.isHalfDay ? days * 0.5 : days));
  }
  return result;
}

export function isWeekend(date: string): boolean {
  const d = new Date(date + "T00:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function isoWeekMonday(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const monday = new Date(d.getTime() - (dow - 1) * 86400000);
  return monday.toISOString().slice(0, 10);
}

export function computeOvertime(
  entries: Array<{ date: string; hours: number }>,
  dailyThreshold: number,
  weeklyThreshold: number,
): number {
  const dailyTotals = new Map<string, number>();
  for (const e of entries) {
    dailyTotals.set(e.date, (dailyTotals.get(e.date) ?? 0) + e.hours);
  }

  const weekData = new Map<string, { total: number; dailyOt: number }>();
  for (const [date, dayTotal] of dailyTotals) {
    const weekKey = isoWeekMonday(date);
    const existing = weekData.get(weekKey) ?? { total: 0, dailyOt: 0 };
    const dailyOt = Math.max(0, dayTotal - dailyThreshold);
    existing.total += dayTotal;
    existing.dailyOt += dailyOt;
    weekData.set(weekKey, existing);
  }

  let totalOt = 0;
  for (const [, week] of weekData) {
    const weeklyOt = Math.max(0, week.total - weeklyThreshold - week.dailyOt);
    totalOt += week.dailyOt + weeklyOt;
  }

  return round2(totalOt);
}

export const DEFAULT_PAYROLL_MAPPING: PayrollMapping = {
  provider: "GENERIC",
  columns: [
    { key: "employeeName", header: "Employee Name", enabled: true },
    { key: "employeeEmail", header: "Employee Email", enabled: true },
    { key: "employeeId", header: "Employee ID", enabled: true },
    { key: "periodStart", header: "Period Start", enabled: true },
    { key: "periodEnd", header: "Period End", enabled: true },
    { key: "regularHours", header: "Regular Hours", enabled: true },
    { key: "overtimeHours", header: "Overtime Hours", enabled: true },
    { key: "holidayHours", header: "Holiday Hours", enabled: true },
    { key: "weekendHours", header: "Weekend Hours", enabled: true },
    { key: "breakHours", header: "Break Hours", enabled: true },
    { key: "leaveDays", header: "Leave Days", enabled: true },
    { key: "billableHours", header: "Billable Hours", enabled: true },
    { key: "nonBillableHours", header: "Non-Billable Hours", enabled: true },
    { key: "totalPayableHours", header: "Total Payable Hours", enabled: true },
    { key: "entryCount", header: "Entry Count", enabled: true },
  ],
};
