import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql, sum } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  leaveBalances,
  leavePolicies,
  organizationMembers,
  payrollRunEmployees,
  payrollRuns,
} from "../../../db/schema";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { toCalculationSnapshot } from "../dto/payroll.schemas";
import type { FnfSuggestionQuery } from "./dto/fnf-suggestion.schemas";

export const GRATUITY_CAP_MINOR = 20_00_000_00;
const GRATUITY_MIN_YEARS = 5;
const FINAL_RUN_STATUSES = ["APPROVED", "LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED"] as const;

export function completedService(joiningDate: string, lastWorkingDay: string) {
  const [y1, m1, d1] = joiningDate.split("-").map(Number);
  const [y2, m2, d2] = lastWorkingDay.split("-").map(Number);
  const months = Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
  return { years: Math.floor(months / 12), months: months % 12 };
}

export function gratuityMinor(monthlyBasicMinor: number, service: { years: number; months: number }) {
  const eligible = service.years >= GRATUITY_MIN_YEARS;
  const countedYears = service.years + (service.months >= 6 ? 1 : 0);
  if (!eligible) return { eligible, countedYears, amountMinor: 0, capped: false };
  const raw = Math.round((monthlyBasicMinor * 15 * countedYears) / 26);
  return { eligible, countedYears, amountMinor: Math.min(raw, GRATUITY_CAP_MINOR), capped: raw > GRATUITY_CAP_MINOR };
}

export function leaveEncashmentMinor(monthlyBasicMinor: number, days: number) {
  return Math.round((monthlyBasicMinor * days) / 26);
}

const toMinor = (major: string | number) => Math.round(Number(major) * 100);
const toMajor = (minor: number) => (minor / 100).toFixed(2);

@Injectable()
export class FnfSuggestionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly facts: EmploymentFactsService,
  ) {}

  async suggest(orgId: string, query: FnfSuggestionQuery) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, query.userId), eq(organizationMembers.orgId, orgId)),
      columns: { id: true },
    });
    if (!member) throw new NotFoundException("User not found in your organization");

    const [facts, basic, leaveDays] = await Promise.all([
      this.facts.getFacts(orgId, query.userId),
      this.lastDrawnBasic(orgId, query.userId),
      this.encashableLeaveDays(orgId, query.userId, Number(query.lastWorkingDay.slice(0, 4))),
    ]);

    const notes: string[] = [];
    const joiningDate = facts.joiningDate;
    const service = joiningDate ? completedService(joiningDate, query.lastWorkingDay) : { years: 0, months: 0 };
    if (!joiningDate) notes.push("No joining date on the employee record, so gratuity is 0. Add it in HR and refill.");
    const basicMinor = basic ? toMinor(basic.amount) : 0;
    if (!basic) notes.push("No processed payslip with a BASIC line, so gratuity and leave encashment are 0.");
    const gratuity = joiningDate ? gratuityMinor(basicMinor, service) : { eligible: false, countedYears: 0, amountMinor: 0, capped: false };
    if (joiningDate && !gratuity.eligible)
      notes.push(`Gratuity needs 5 completed years of service; this employee has ${service.years}y ${service.months}m.`);
    if (gratuity.capped) notes.push("Gratuity is capped at ₹20,00,000.");
    if (leaveDays === 0) notes.push("No encashable leave balance found for this year.");
    notes.push("Notice-period pay or recovery is not suggested. Enter it manually.");

    return {
      userId: query.userId,
      joiningDate,
      lastWorkingDay: query.lastWorkingDay,
      lastDrawnBasic: basic ? toMajor(basicMinor) : null,
      basicMonth: basic?.month ?? null,
      serviceYears: service.years,
      serviceMonths: service.months,
      gratuityYears: gratuity.countedYears,
      gratuityEligible: gratuity.eligible,
      gratuityCapped: gratuity.capped,
      gratuity: toMajor(gratuity.amountMinor),
      encashableLeaveDays: leaveDays.toFixed(2),
      leaveEncashment: toMajor(leaveEncashmentMinor(basicMinor, leaveDays)),
      notes,
    };
  }

  private async lastDrawnBasic(orgId: string, userId: string) {
    const [row] = await this.db
      .select({ month: payrollRuns.month, snapshot: payrollRunEmployees.calculationSnapshot })
      .from(payrollRunEmployees)
      .innerJoin(payrollRuns, and(eq(payrollRuns.orgId, payrollRunEmployees.orgId), eq(payrollRuns.id, payrollRunEmployees.runId)))
      .where(
        and(
          eq(payrollRunEmployees.orgId, orgId),
          eq(payrollRunEmployees.userId, userId),
          inArray(payrollRuns.status, [...FINAL_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(payrollRuns.month))
      .limit(1);
    const lines = toCalculationSnapshot(row?.snapshot)?.lines ?? [];
    const basicLines = lines.filter((l) => l.category === "EARNING" && (l.code === "BASIC" || l.code === "DA"));
    if (!row || basicLines.length === 0) return null;
    return { month: row.month, amount: basicLines.reduce((total, l) => total + (Number(l.amount) || 0), 0) };
  }

  private async encashableLeaveDays(orgId: string, userId: string, year: number) {
    const encashable = sql`exists (select 1 from ${leavePolicies} where ${leavePolicies.orgId} = ${orgId} and ${leavePolicies.leaveTypeId} = ${leaveBalances.leaveTypeId} and ${leavePolicies.encashable} and ${leavePolicies.isActive})`;
    const [row] = await this.db
      .select({ days: sum(leaveBalances.balance) })
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.userId, userId),
          eq(leaveBalances.year, year),
          encashable,
        ),
      );
    return Number(row?.days ?? 0);
  }
}
