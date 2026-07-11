import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  payrolls,
  salaryStructures,
  organizationMembers,
  users,
  organizations,
  attendance,
  payrollPolicies,
  payrollPolicyVersions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { decrypt } from "./lib/encryption";
import type { GenerateSinglePayrollInput } from "./dto/payroll.schemas";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { resolvePayrollDefaults, countWorkingDays } from "./lib/payroll-defaults";

type PayrollRow = typeof payrolls.$inferSelect;
type UserRow = typeof users.$inferSelect;
type OrgRow = typeof organizations.$inferSelect;

export type PayslipDownloadResult =
  | { ok: false; reason: "not_found" | "not_paid" | "forbidden" }
  | { ok: true; payroll: PayrollRow; employee: UserRow | undefined; org: OrgRow | undefined };

export type GenerateSingleResult =
  | { ok: false; reason: "no_salary_structure" | "duplicate"; month: string }
  | { ok: true };

@Injectable()
export class PayrollsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async resolveDefaults(orgId: string) {
    try {
      const policy = await this.db.query.payrollPolicies.findFirst({
        where: eq(payrollPolicies.orgId, orgId),
        columns: { activeVersionId: true },
      });
      if (!policy?.activeVersionId) return resolvePayrollDefaults(null);

      const version = await this.db.query.payrollPolicyVersions.findFirst({
        where: eq(payrollPolicyVersions.id, policy.activeVersionId),
        columns: { config: true },
      });
      return resolvePayrollDefaults(version?.config ?? null);
    } catch {
      return resolvePayrollDefaults(null);
    }
  }

  getPayrolls(orgId: string, userId: string) {
    return this.db.query.payrolls.findMany({
      where: and(eq(payrolls.userId, userId), eq(payrolls.orgId, orgId)),
      orderBy: [desc(payrolls.createdAt)],
    });
  }

  async generateBulk(orgId: string, userId: string, month: string): Promise<{ generated: number; hadMembers: boolean }> {
    const memberships = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
    });

    const memberUserIds = memberships.map((m) => m.userId).filter(Boolean);
    if (memberUserIds.length === 0) return { generated: 0, hadMembers: false };

    const [allSalaryStructures, existingPayrolls, allUsers, defaults] = await Promise.all([
      this.db.query.salaryStructures.findMany({
        where: and(
          inArray(salaryStructures.userId, memberUserIds),
          eq(salaryStructures.orgId, orgId),
          eq(salaryStructures.isActive, true),
        ),
      }),
      this.db.query.payrolls.findMany({
        where: and(
          inArray(payrolls.userId, memberUserIds),
          eq(payrolls.month, month),
          eq(payrolls.orgId, orgId),
        ),
      }),
      this.db.query.users.findMany({
        where: inArray(users.id, memberUserIds),
        columns: { id: true, monthlySalary: true },
      }),
      this.resolveDefaults(orgId),
    ]);

    const salaryMap = new Map(allSalaryStructures.map((s) => [s.userId, s]));
    const userMap = new Map(allUsers.map((u) => [u.id, u.monthlySalary]));
    const existingPayrollUserIds = new Set(existingPayrolls.map((p) => p.userId));

    const [yearStr, monthStr] = month.split("-");
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    let totalBusinessDays = countWorkingDays(year, monthNum, defaults.workWeekDays);
    if (totalBusinessDays <= 0) totalBusinessDays = defaults.standardWorkingDaysPerMonth;

    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;

    const attendanceMap = new Map<string, number>();
    try {
      const attendanceRecords = await this.db
        .select({
          userId: attendance.userId,
          daysPresent: sql<number>`count(*)`.as("days_present"),
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            inArray(attendance.userId, memberUserIds),
            gte(attendance.date, monthStart),
            lte(attendance.date, monthEnd),
            sql`${attendance.status} IN ('PRESENT', 'HALF_DAY', 'LATE')`,
          ),
        )
        .groupBy(attendance.userId);
      for (const rec of attendanceRecords) {
        attendanceMap.set(rec.userId, Number(rec.daysPresent));
      }
    } catch (e) {
      logger.warn("Failed to fetch attendance data for payroll", {
        error: e instanceof Error ? e.message : "Unknown",
        month,
      });
    }

    const {
      defaultBasicPercent,
      defaultHraPercent,
      defaultAllowancePercent,
      professionalTaxMonthly,
      lopBasis,
    } = defaults;

    const newPayrolls = memberUserIds
      .filter((uId) => {
        if (existingPayrollUserIds.has(uId)) return false;
        const hasSalaryStructure = salaryMap.has(uId);
        const hasMonthlySalary = userMap.has(uId) && parseFloat(userMap.get(uId) || "0") > 0;
        return hasSalaryStructure || hasMonthlySalary;
      })
      .map((uId) => {
        const salaryStructure = salaryMap.get(uId);
        const monthlySalaryStr = userMap.get(uId);
        const monthlySalary = monthlySalaryStr ? parseFloat(monthlySalaryStr) : 0;

        const basic = salaryStructure
          ? parseFloat(salaryStructure.basicSalary)
          : monthlySalary * (defaultBasicPercent / 100);
        const hraPercentage = salaryStructure
          ? parseFloat(salaryStructure.hraPercentage || String(defaultHraPercent))
          : defaultHraPercent;
        const hra = salaryStructure ? basic * (hraPercentage / 100) : monthlySalary * (defaultHraPercent / 100);
        const allowances = salaryStructure
          ? parseFloat(salaryStructure.allowances || "0")
          : monthlySalary * (defaultAllowancePercent / 100);
        const deductions = salaryStructure ? parseFloat(salaryStructure.deductions || "0") : 0;
        const gross = basic + hra + allowances;

        const lopDivisor = lopBasis === "calendar" ? daysInMonth : totalBusinessDays;

        let lopDeduction = 0;
        const daysAttended = attendanceMap.get(uId);
        if (daysAttended !== undefined && daysAttended < totalBusinessDays) {
          const dailySalary = gross / lopDivisor;
          const absentDays = totalBusinessDays - daysAttended;
          lopDeduction = Math.round(dailySalary * absentDays * 100) / 100;
        }

        const totalDeductions = deductions + lopDeduction + professionalTaxMonthly;
        const net = gross - totalDeductions;

        return {
          orgId,
          userId: uId,
          month,
          basicSalary: basic.toString(),
          hra: hra.toString(),
          allowances: allowances.toString(),
          deductions: totalDeductions.toString(),
          grossSalary: gross.toString(),
          netSalary: net.toString(),
          status: "DRAFT" as const,
          generatedBy: userId,
        };
      });

    if (newPayrolls.length > 0) {
      await this.db.insert(payrolls).values(newPayrolls);
    }

    return { generated: newPayrolls.length, hadMembers: true };
  }

  async getAllPayrolls(orgId: string, filter: { month?: string; year?: string }, scope: DataScope, userId: string) {
    const generatorUser = alias(users, "generator_user");
    const approverUser = alias(users, "approver_user");

    const conditions = [
      eq(payrolls.orgId, orgId),
      applyScope(scope, userId, { ownerColumn: payrolls.userId }),
    ];
    if (filter.month) {
      conditions.push(eq(payrolls.month, filter.month));
    } else if (filter.year) {
      conditions.push(like(payrolls.month, `${filter.year}-%`));
    }

    const rows = await this.db
      .select({
        id: payrolls.id,
        orgId: payrolls.orgId,
        userId: payrolls.userId,
        month: payrolls.month,
        basicSalary: payrolls.basicSalary,
        hra: payrolls.hra,
        allowances: payrolls.allowances,
        deductions: payrolls.deductions,
        grossSalary: payrolls.grossSalary,
        netSalary: payrolls.netSalary,
        status: payrolls.status,
        generatedBy: payrolls.generatedBy,
        approvedBy: payrolls.approvedBy,
        overtimeType: payrolls.overtimeType,
        overtimeDays: payrolls.overtimeDays,
        overtimeHours: payrolls.overtimeHours,
        overtimeAmount: payrolls.overtimeAmount,
        payslipUrl: payrolls.payslipUrl,
        createdAt: payrolls.createdAt,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userDesignation: users.designation,
        userMonthlySalary: users.monthlySalary,
        generatedByName: generatorUser.firstName,
        approvedByName: approverUser.firstName,
      })
      .from(payrolls)
      .innerJoin(users, eq(payrolls.userId, users.id))
      .leftJoin(generatorUser, eq(payrolls.generatedBy, generatorUser.id))
      .leftJoin(approverUser, eq(payrolls.approvedBy, approverUser.id))
      .where(and(...conditions))
      .orderBy(desc(payrolls.createdAt))
      .limit(1000);

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      userId: r.userId,
      month: r.month,
      basicSalary: r.basicSalary,
      hra: r.hra,
      allowances: r.allowances,
      deductions: r.deductions,
      grossSalary: r.grossSalary,
      netSalary: r.netSalary,
      status: r.status,
      generatedBy: r.generatedBy,
      approvedBy: r.approvedBy,
      overtimeType: r.overtimeType,
      overtimeDays: r.overtimeDays,
      overtimeHours: r.overtimeHours,
      overtimeAmount: r.overtimeAmount,
      payslipUrl: r.payslipUrl,
      createdAt: r.createdAt,
      generatedByName: r.generatedByName,
      approvedByName: r.approvedByName,
      user: {
        firstName: r.userFirstName,
        lastName: r.userLastName,
        designation: r.userDesignation,
        monthlySalary: r.userMonthlySalary,
      },
    }));
  }

  async generateSingle(orgId: string, userId: string, body: GenerateSinglePayrollInput): Promise<GenerateSingleResult> {
    const [salary, defaults] = await Promise.all([
      this.db.query.salaryStructures.findFirst({
        where: and(
          eq(salaryStructures.userId, body.userId),
          eq(salaryStructures.orgId, orgId),
          eq(salaryStructures.isActive, true),
        ),
      }),
      this.resolveDefaults(orgId),
    ]);

    if (!salary) return { ok: false, reason: "no_salary_structure", month: body.month };

    const existingPayroll = await this.db.query.payrolls.findFirst({
      where: and(
        eq(payrolls.orgId, orgId),
        eq(payrolls.userId, body.userId),
        eq(payrolls.month, body.month),
      ),
      columns: { id: true },
    });
    if (existingPayroll) return { ok: false, reason: "duplicate", month: body.month };

    const basicSalary = Number(salary.basicSalary);
    const hraPercentage = Number(salary.hraPercentage || defaults.defaultHraPercent);
    const allowances = Number(salary.allowances || 0);
    const deductions = Number(salary.deductions || 0);

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const hra = round2((basicSalary * hraPercentage) / 100);
    const grossSalary = round2(basicSalary + hra + allowances + (body.bonus || 0) + (body.overtimeAmount || 0));

    const [payYear, payMonth] = body.month.split("-").map(Number);
    const daysInMonth = new Date(payYear, payMonth, 0).getDate();

    const { professionalTaxMonthly, lopBasis } = defaults;
    const lopDivisor = lopBasis === "calendar" ? daysInMonth : countWorkingDays(payYear, payMonth, defaults.workWeekDays);
    const lopDeduction = body.lopDays ? round2((basicSalary / lopDivisor) * body.lopDays) : 0;
    const halfDayDeduction = body.halfDays ? round2(((basicSalary / lopDivisor) * body.halfDays) / 2) : 0;
    const totalDeductions = round2(deductions + lopDeduction + halfDayDeduction + (body.otherDeductions || 0) + professionalTaxMonthly);

    const netSalary = round2(grossSalary - totalDeductions);

    const [payroll] = await this.db
      .insert(payrolls)
      .values({
        orgId,
        userId: body.userId,
        month: body.month,
        basicSalary: basicSalary.toString(),
        hra: hra.toString(),
        allowances: (allowances + (body.bonus || 0)).toString(),
        deductions: totalDeductions.toString(),
        grossSalary: grossSalary.toString(),
        netSalary: netSalary.toString(),
        status: "DRAFT",
        generatedBy: userId,
        overtimeType: body.overtimeType,
        overtimeDays: body.overtimeDays?.toString(),
        overtimeHours: body.overtimeHours?.toString(),
        overtimeAmount: body.overtimeAmount?.toString(),
      })
      .returning();

    this.audit.log({
      action: "hr.payroll_generated",
      userId,
      orgId,
      targetId: String(payroll.id),
      targetType: "payroll",
      metadata: { employeeId: body.userId, month: body.month, netSalary },
    });

    return { ok: true };
  }

  async getPayslipDownload(orgId: string, payrollId: number, userId: string, isAdmin: boolean): Promise<PayslipDownloadResult> {
    const payroll = await this.db.query.payrolls.findFirst({
      where: and(eq(payrolls.id, payrollId), eq(payrolls.orgId, orgId)),
    });
    if (!payroll) return { ok: false, reason: "not_found" };
    if (payroll.status !== "PAID") return { ok: false, reason: "not_paid" };
    if (!isAdmin && payroll.userId !== userId) return { ok: false, reason: "forbidden" };

    const [employee, org] = await Promise.all([
      this.db.query.users.findFirst({ where: eq(users.id, payroll.userId) }),
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
    ]);

    return { ok: true, payroll, employee, org };
  }

  getEmployeePayslips(orgId: string, userId: string) {
    return this.db
      .select({
        id: payrolls.id,
        userId: payrolls.userId,
        month: payrolls.month,
        basicSalary: payrolls.basicSalary,
        hra: payrolls.hra,
        allowances: payrolls.allowances,
        deductions: payrolls.deductions,
        grossSalary: payrolls.grossSalary,
        netSalary: payrolls.netSalary,
        status: payrolls.status,
        overtimeType: payrolls.overtimeType,
        overtimeDays: payrolls.overtimeDays,
        overtimeHours: payrolls.overtimeHours,
        overtimeAmount: payrolls.overtimeAmount,
      })
      .from(payrolls)
      .where(and(eq(payrolls.orgId, orgId), eq(payrolls.userId, userId)))
      .orderBy(desc(payrolls.month))
      .limit(120);
  }

  async getPayrollReports(orgId: string, year: number, reportType: string) {
    const yearStart = `${year}-01`;
    const yearEnd = `${year}-12`;

    if (reportType === "form16") {
      const employeePayrolls = await this.db
        .select({
          userId: payrolls.userId,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          taxId: users.taxId,
          totalGross: sql<string>`SUM(${payrolls.grossSalary}::numeric)`,
          totalNet: sql<string>`SUM(${payrolls.netSalary}::numeric)`,
          totalDeductions: sql<string>`SUM(${payrolls.deductions}::numeric)`,
          months: sql<number>`count(*)`,
        })
        .from(payrolls)
        .innerJoin(users, eq(payrolls.userId, users.id))
        .where(and(eq(payrolls.orgId, orgId), gte(payrolls.month, yearStart), lte(payrolls.month, yearEnd)))
        .groupBy(payrolls.userId, users.firstName, users.lastName, users.email, users.taxId)
        .limit(1000);

      return {
        type: "form16",
        year,
        employees: employeePayrolls.map((e) => ({
          userId: e.userId,
          name: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
          email: e.email,
          pan: e.taxId ? decrypt(e.taxId) : null,
          totalGross: Number(e.totalGross ?? 0).toFixed(2),
          totalNet: Number(e.totalNet ?? 0).toFixed(2),
          totalDeductions: Number(e.totalDeductions ?? 0).toFixed(2),
          monthsProcessed: Number(e.months),
        })),
      };
    }

    const monthlySummary = await this.db
      .select({
        month: payrolls.month,
        totalGross: sql<string>`SUM(${payrolls.grossSalary}::numeric)`,
        totalNet: sql<string>`SUM(${payrolls.netSalary}::numeric)`,
        totalDeductions: sql<string>`SUM(${payrolls.deductions}::numeric)`,
        employeeCount: sql<number>`count(DISTINCT ${payrolls.userId})`,
      })
      .from(payrolls)
      .where(and(eq(payrolls.orgId, orgId), gte(payrolls.month, yearStart), lte(payrolls.month, yearEnd)))
      .groupBy(payrolls.month)
      .orderBy(payrolls.month)
      .limit(12);

    return {
      type: "summary",
      year,
      months: monthlySummary.map((m) => ({
        month: m.month,
        totalGross: Number(m.totalGross ?? 0).toFixed(2),
        totalNet: Number(m.totalNet ?? 0).toFixed(2),
        totalDeductions: Number(m.totalDeductions ?? 0).toFixed(2),
        employeeCount: Number(m.employeeCount),
      })),
    };
  }
}
