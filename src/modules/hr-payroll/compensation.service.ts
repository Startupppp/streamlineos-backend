import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, eq, gte, lte, max, min, sql, sum } from "drizzle-orm";
import {
  payrolls,
  salaryStructures,
  departmentMembers,
  departments,
  organizationMembers,
  users,
  expenses,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { AccountingExportInput, TaxCalcInput } from "./dto/payroll.schemas";

const SALARY_BANDS = [
  { label: "< 3L", min: 0, max: 300_000 },
  { label: "3–6L", min: 300_000, max: 600_000 },
  { label: "6–10L", min: 600_000, max: 1_000_000 },
  { label: "10–15L", min: 1_000_000, max: 1_500_000 },
  { label: "15–25L", min: 1_500_000, max: 2_500_000 },
  { label: "> 25L", min: 2_500_000, max: Infinity },
];

const OLD_REGIME_SLABS = [
  { min: 0, max: 250000, rate: 0 },
  { min: 250000, max: 500000, rate: 5 },
  { min: 500000, max: 1000000, rate: 20 },
  { min: 1000000, max: Infinity, rate: 30 },
];

const NEW_REGIME_SLABS = [
  { min: 0, max: 300000, rate: 0 },
  { min: 300000, max: 700000, rate: 5 },
  { min: 700000, max: 1000000, rate: 10 },
  { min: 1000000, max: 1200000, rate: 15 },
  { min: 1200000, max: 1500000, rate: 20 },
  { min: 1500000, max: Infinity, rate: 30 },
];

type PayrollExportRow = {
  firstName: string | null;
  lastName: string | null;
  grossSalary: string;
  netSalary: string;
  deductions: string | null;
};

function calculateTax(taxableIncome: number, slabs: typeof OLD_REGIME_SLABS): number {
  let tax = 0;
  for (const slab of slabs) {
    if (taxableIncome <= slab.min) break;
    const taxableInSlab = Math.min(taxableIncome, slab.max) - slab.min;
    tax += (taxableInSlab * slab.rate) / 100;
  }
  return Math.round(tax);
}

function generateTallyXml(payroll: PayrollExportRow[], month: string): string {
  const vouchers = payroll
    .map((p) => {
      const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
      return `<VOUCHER><DATE>${month}-28</DATE><NARRATION>Salary - ${name}</NARRATION><AMOUNT>${p.netSalary}</AMOUNT><LEDGER>Salary Payable</LEDGER></VOUCHER>`;
    })
    .join("\n");
  return `<?xml version="1.0"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY>${vouchers}</BODY></ENVELOPE>`;
}

function generateQuickBooksCsv(payroll: PayrollExportRow[], month: string): string {
  const header = "Date,Employee,Description,Debit,Credit";
  const rows = payroll.map((p) => {
    const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
    return `${month}-28,"${name}","Monthly Salary",${p.grossSalary},${p.netSalary}`;
  });
  return [header, ...rows].join("\n");
}

@Injectable()
export class CompensationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getPayrollSummary(orgId: string) {
    return this.cache.cached(
      `hr:dashboard:payroll-summary:${orgId}`,
      async () => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const currentMonth = `${year}-${month}`;

        const [currentResult, prevResult] = await Promise.all([
          this.db
            .select({
              totalGross: sum(payrolls.grossSalary),
              totalNet: sum(payrolls.netSalary),
              totalDeductions: sum(payrolls.deductions),
              count: sql<number>`COUNT(*)`,
            })
            .from(payrolls)
            .where(
              and(
                eq(payrolls.orgId, orgId),
                eq(payrolls.month, currentMonth),
                sql`${payrolls.status} IN ('APPROVED', 'SUBMITTED')`,
              ),
            ),
          this.db
            .select({ totalNet: sum(payrolls.netSalary) })
            .from(payrolls)
            .where(
              and(
                eq(payrolls.orgId, orgId),
                eq(
                  payrolls.month,
                  (() => {
                    const d = new Date(year, now.getMonth() - 1, 1);
                    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                  })(),
                ),
                sql`${payrolls.status} IN ('APPROVED', 'SUBMITTED')`,
              ),
            ),
        ]);

        const cur = currentResult[0];
        const prevNet = Number(prevResult[0]?.totalNet ?? 0);
        const curNet = Number(cur?.totalNet ?? 0);
        const momChange = prevNet > 0 ? Math.round(((curNet - prevNet) / prevNet) * 100) : null;

        return {
          month: currentMonth,
          totalGross: Number(cur?.totalGross ?? 0),
          totalNet: curNet,
          totalDeductions: Number(cur?.totalDeductions ?? 0),
          employeeCount: Number(cur?.count ?? 0),
          prevMonthNet: prevNet,
          momChangePct: momChange,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getSalaryBands(orgId: string) {
    return this.cache.cached(`hr:salary-bands:${orgId}`, async () => {
      const rows = await this.db
        .select({
          departmentName: departments.name,
          avgBasic: avg(salaryStructures.basicSalary).mapWith(Number),
          minBasic: min(salaryStructures.basicSalary).mapWith(Number),
          maxBasic: max(salaryStructures.basicSalary).mapWith(Number),
          employeeCount: count(salaryStructures.userId),
        })
        .from(salaryStructures)
        .innerJoin(departmentMembers, eq(departmentMembers.userId, salaryStructures.userId))
        .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
        .where(eq(salaryStructures.orgId, orgId))
        .groupBy(departments.name);

      const allSalaries = await this.db
        .select({ basicSalary: salaryStructures.basicSalary })
        .from(salaryStructures)
        .where(eq(salaryStructures.orgId, orgId));

      const annualSalaries = allSalaries.map((r) => Number(r.basicSalary) * 12);

      const bandDistribution = SALARY_BANDS.map((band) => ({
        label: band.label,
        count: annualSalaries.filter((s) => s >= band.min && (band.max === Infinity ? true : s < band.max)).length,
      }));

      return {
        byDepartment: rows.map((r) => ({
          department: r.departmentName,
          avgAnnual: Math.round((r.avgBasic ?? 0) * 12),
          minAnnual: Math.round((r.minBasic ?? 0) * 12),
          maxAnnual: Math.round((r.maxBasic ?? 0) * 12),
          employeeCount: r.employeeCount,
        })),
        bandDistribution,
      };
    });
  }

  async getCompensationAnalytics(orgId: string) {
    const [overall, byDept, byRole] = await Promise.all([
      this.db
        .select({
          avgSalary: sql<string>`COALESCE(AVG(${users.monthlySalary}::numeric), 0)`,
          minSalary: sql<string>`COALESCE(MIN(${users.monthlySalary}::numeric), 0)`,
          maxSalary: sql<string>`COALESCE(MAX(${users.monthlySalary}::numeric), 0)`,
          medianSalary: sql<string>`COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${users.monthlySalary}::numeric), 0)`,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
      this.db
        .select({
          departmentId: users.departmentId,
          avgSalary: sql<string>`COALESCE(AVG(${users.monthlySalary}::numeric), 0)`,
          count: sql<number>`count(*)`,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.departmentId),
      this.db
        .select({
          role: users.role,
          avgSalary: sql<string>`COALESCE(AVG(${users.monthlySalary}::numeric), 0)`,
          count: sql<number>`count(*)`,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.role),
    ]);

    const allDepts = await this.db.query.departments.findMany({ where: eq(departments.orgId, orgId) });
    const deptMap = new Map(allDepts.map((d) => [d.id, d.name]));

    return {
      overall: {
        avgSalary: Number(overall[0]?.avgSalary ?? 0).toFixed(0),
        minSalary: Number(overall[0]?.minSalary ?? 0).toFixed(0),
        maxSalary: Number(overall[0]?.maxSalary ?? 0).toFixed(0),
        medianSalary: Number(overall[0]?.medianSalary ?? 0).toFixed(0),
      },
      byDepartment: byDept.map((d) => ({
        department: d.departmentId ? (deptMap.get(d.departmentId) ?? "Other") : "Unassigned",
        avgSalary: Number(d.avgSalary).toFixed(0),
        count: Number(d.count),
      })),
      byRole: byRole.map((r) => ({
        role: r.role,
        avgSalary: Number(r.avgSalary).toFixed(0),
        count: Number(r.count),
      })),
    };
  }

  async accountingExport(orgId: string, body: AccountingExportInput) {
    const [year, monthNum] = body.month.split("-");
    const lastDay = new Date(Number(year), Number(monthNum), 0).getDate();
    const startDate = `${body.month}-01`;
    const endDate = `${body.month}-${String(lastDay).padStart(2, "0")}`;

    const [payrollData, expenseData] = await Promise.all([
      this.db
        .select({
          userId: payrolls.userId,
          firstName: users.firstName,
          lastName: users.lastName,
          basicSalary: payrolls.basicSalary,
          hra: payrolls.hra,
          allowances: payrolls.allowances,
          deductions: payrolls.deductions,
          grossSalary: payrolls.grossSalary,
          netSalary: payrolls.netSalary,
        })
        .from(payrolls)
        .innerJoin(users, eq(payrolls.userId, users.id))
        .where(and(eq(payrolls.orgId, orgId), eq(payrolls.month, body.month))),
      this.db
        .select({
          userId: expenses.userId,
          category: expenses.category,
          amount: expenses.amount,
          description: expenses.description,
          expenseDate: expenses.expenseDate,
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.orgId, orgId),
            eq(expenses.status, "APPROVED"),
            gte(expenses.expenseDate, startDate),
            lte(expenses.expenseDate, endDate),
          ),
        ),
    ]);

    if (body.format === "TALLY_XML") {
      return { format: "TALLY_XML", data: generateTallyXml(payrollData, body.month) };
    }

    if (body.format === "QUICKBOOKS_CSV") {
      return { format: "QUICKBOOKS_CSV", data: generateQuickBooksCsv(payrollData, body.month) };
    }

    return {
      format: "JSON",
      month: body.month,
      payroll: payrollData.map((p) => ({
        employee: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
        basic: p.basicSalary,
        hra: p.hra,
        allowances: p.allowances,
        deductions: p.deductions,
        gross: p.grossSalary,
        net: p.netSalary,
      })),
      expenses: expenseData.map((e) => ({
        category: e.category,
        amount: e.amount,
        description: e.description,
        date: e.expenseDate,
      })),
    };
  }

  calculateTax(body: TaxCalcInput) {
    const { annualCtc, basicPercentage, hraPercentage, regime, pfOptOut } = body;

    const basic = (annualCtc * basicPercentage) / 100;
    const hra = (basic * hraPercentage) / 100;
    const pfEmployee = pfOptOut ? 0 : Math.min(basic * 0.12, 21600);
    const pfEmployer = pfOptOut ? 0 : Math.min(basic * 0.12, 21600);
    const esiEmployee = annualCtc <= 252000 ? annualCtc * 0.0075 : 0;
    const esiEmployer = annualCtc <= 252000 ? annualCtc * 0.0325 : 0;
    const professionalTax = 2400;
    const standardDeduction = 75000;

    const grossSalary = annualCtc - pfEmployer - esiEmployer;
    const taxableIncome = Math.max(0, grossSalary - standardDeduction - (regime === "OLD" ? pfEmployee : 0));

    const slabs = regime === "NEW" ? NEW_REGIME_SLABS : OLD_REGIME_SLABS;
    const incomeTax = calculateTax(taxableIncome, slabs);
    const cess = Math.round(incomeTax * 0.04);
    const totalTax = incomeTax + cess;
    const monthlyTds = Math.round(totalTax / 12);

    const monthlyNet = Math.round((grossSalary - pfEmployee - esiEmployee - professionalTax - totalTax) / 12);

    return {
      annual: {
        ctc: annualCtc,
        basic: Math.round(basic),
        hra: Math.round(hra),
        pfEmployee: Math.round(pfEmployee),
        pfEmployer: Math.round(pfEmployer),
        esiEmployee: Math.round(esiEmployee),
        esiEmployer: Math.round(esiEmployer),
        professionalTax,
        standardDeduction,
        grossSalary: Math.round(grossSalary),
        taxableIncome: Math.round(taxableIncome),
        incomeTax,
        cess,
        totalTax,
      },
      monthly: {
        gross: Math.round(grossSalary / 12),
        basic: Math.round(basic / 12),
        hra: Math.round(hra / 12),
        pf: Math.round(pfEmployee / 12),
        esi: Math.round(esiEmployee / 12),
        professionalTax: Math.round(professionalTax / 12),
        tds: monthlyTds,
        netTakeHome: monthlyNet,
      },
      regime,
      slabs: slabs.map((s) => ({
        range: `${s.min.toLocaleString("en-IN")} - ${s.max === Infinity ? "Above" : s.max.toLocaleString("en-IN")}`,
        rate: `${s.rate}%`,
      })),
    };
  }
}
