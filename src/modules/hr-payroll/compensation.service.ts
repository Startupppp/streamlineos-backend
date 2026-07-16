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
import { getStatutoryConfig, calculateIncomeTax } from "./lib/statutory-config";

type PayrollExportRow = {
  firstName: string | null;
  lastName: string | null;
  grossSalary: string;
  netSalary: string;
  deductions: string | null;
};

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
                sql`${payrolls.status} IN ('APPROVED', 'PENDING_APPROVAL')`,
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
                sql`${payrolls.status} IN ('APPROVED', 'PENDING_APPROVAL')`,
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
      const config = getStatutoryConfig("IN");

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
        .where(eq(salaryStructures.orgId, orgId))
        .limit(10000);

      const annualSalaries = allSalaries.map((r) => Number(r.basicSalary) * 12);

      const bandDistribution = config.salaryBands.map((band) => ({
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
    const [overall, byDept, byRole, allDepts] = await Promise.all([
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
      this.db.query.departments.findMany({ where: eq(departments.orgId, orgId) }),
    ]);

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
    const cfg = getStatutoryConfig("IN");
    const { pf, esi, professionalTaxAnnual, incomeTax } = cfg;

    const basic = (annualCtc * basicPercentage) / 100;
    const hra = (basic * hraPercentage) / 100;
    const pfEmployee = pfOptOut ? 0 : Math.min(basic * (pf.employeePercent / 100), pf.annualWageCeiling);
    const pfEmployer = pfOptOut ? 0 : Math.min(basic * (pf.employerPercent / 100), pf.annualWageCeiling);
    const esiMonthlyWageCeiling = esi.monthlyWageCeiling * 12;
    const esiEmployee = annualCtc <= esiMonthlyWageCeiling ? annualCtc * (esi.employeePercent / 100) : 0;
    const esiEmployer = annualCtc <= esiMonthlyWageCeiling ? annualCtc * (esi.employerPercent / 100) : 0;
    const standardDeduction = incomeTax.standardDeduction;

    const grossSalary = annualCtc - pfEmployer - esiEmployer;
    const taxableIncome = Math.max(0, grossSalary - standardDeduction - (regime === "OLD" ? pfEmployee : 0));

    const slabs = regime === "NEW" ? incomeTax.newRegimeSlabs : incomeTax.oldRegimeSlabs;
    const incomeTaxAmount = calculateIncomeTax(taxableIncome, slabs);
    const cess = Math.round(incomeTaxAmount * (incomeTax.cessPercent / 100));
    const totalTax = incomeTaxAmount + cess;
    const monthlyTds = Math.round(totalTax / 12);

    const monthlyNet = Math.round((grossSalary - pfEmployee - esiEmployee - professionalTaxAnnual - totalTax) / 12);

    return {
      annual: {
        ctc: annualCtc,
        basic: Math.round(basic),
        hra: Math.round(hra),
        pfEmployee: Math.round(pfEmployee),
        pfEmployer: Math.round(pfEmployer),
        esiEmployee: Math.round(esiEmployee),
        esiEmployer: Math.round(esiEmployer),
        professionalTax: professionalTaxAnnual,
        standardDeduction,
        grossSalary: Math.round(grossSalary),
        taxableIncome: Math.round(taxableIncome),
        incomeTax: incomeTaxAmount,
        cess,
        totalTax,
      },
      monthly: {
        gross: Math.round(grossSalary / 12),
        basic: Math.round(basic / 12),
        hra: Math.round(hra / 12),
        pf: Math.round(pfEmployee / 12),
        esi: Math.round(esiEmployee / 12),
        professionalTax: Math.round(professionalTaxAnnual / 12),
        tds: monthlyTds,
        netTakeHome: monthlyNet,
      },
      regime,
      slabs: slabs.map((s) => ({
        range: `${s.min.toLocaleString(cfg.locale)} - ${s.max === Infinity ? "Above" : s.max.toLocaleString(cfg.locale)}`,
        rate: `${s.rate}%`,
      })),
    };
  }
}
