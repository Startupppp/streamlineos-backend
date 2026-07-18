import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { payrolls, users, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { decrypt, decryptBankDetails } from "./lib/encryption";
import { generatePayslipPdf } from "./lib/payslip-pdf";
import { getPayslipEmailTemplate } from "../email/templates/payroll";

type PayrollRow = typeof payrolls.$inferSelect;

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthLabel(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  const monthIndex = Number(monthStr) - 1;
  const label = MONTHS_LONG[monthIndex];
  if (!label) return "Unknown Month";
  return `${label} ${yearStr}`;
}

function formatJoiningDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

@Injectable()
export class PayrollStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
  ) {}

  async approve(orgId: string, userId: string, payrollId: number): Promise<{ ok: false } | { ok: true }> {
    const existing = await this.db.query.payrolls.findFirst({
      where: and(eq(payrolls.id, payrollId), eq(payrolls.orgId, orgId)),
    });
    if (!existing) return { ok: false };

    await this.db
      .update(payrolls)
      .set({ status: "APPROVED", approvedBy: userId })
      .where(and(eq(payrolls.id, payrollId), eq(payrolls.orgId, orgId)));

    void this.cache.del(`hr:dashboard:payroll-summary:${orgId}`);

    this.audit.log({
      action: "hr.payroll_approved",
      userId,
      orgId,
      targetId: String(payrollId),
      targetType: "payroll",
      metadata: { employeeId: existing.userId, month: existing.month },
    });

    return { ok: true };
  }

  async markPaid(
    orgId: string,
    userId: string,
    payrollId: number,
  ): Promise<{ ok: false; reason: "not_found" | "not_approved" } | { ok: true }> {
    const existing = await this.db.query.payrolls.findFirst({
      where: and(eq(payrolls.id, payrollId), eq(payrolls.orgId, orgId)),
    });
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.status !== "APPROVED") return { ok: false, reason: "not_approved" };

    await this.db.update(payrolls).set({ status: "PAID" }).where(and(eq(payrolls.id, payrollId), eq(payrolls.orgId, orgId)));

    void this.cache.del(`hr:dashboard:payroll-summary:${orgId}`);

    this.audit.log({
      action: "hr.payroll_paid",
      userId,
      orgId,
      targetId: String(payrollId),
      targetType: "payroll",
      metadata: { employeeId: existing.userId, month: existing.month, netSalary: existing.netSalary },
    });

    void this.notifyPaid(orgId, existing);

    return { ok: true };
  }

  private async notifyPaid(orgId: string, payroll: PayrollRow): Promise<void> {
    try {
      const [employee, org] = await Promise.all([
        this.db.query.users.findFirst({ where: eq(users.id, payroll.userId) }),
        this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
      ]);
      if (!employee?.email) return;

      const monthLabel = payroll.month ? formatMonthLabel(payroll.month) : "Unknown Month";

      const basic = parseFloat(payroll.basicSalary || "0");
      const hra = parseFloat(payroll.hra || "0");
      const allowances = parseFloat(payroll.allowances || "0");
      const overtimeAmount = parseFloat(payroll.overtimeAmount || "0");
      const grossSalary = parseFloat(payroll.grossSalary || "0");
      const deductions = parseFloat(payroll.deductions || "0");
      const netSalary = parseFloat(payroll.netSalary || "0");

      const orgAddress = org?.address;
      const addressLine = [orgAddress?.city, orgAddress?.state, orgAddress?.country].filter(Boolean).join(", ");

      const bank = decryptBankDetails(employee.bankDetails);
      const maskedAccount = bank?.accountNumber ? "XXXX" + bank.accountNumber.slice(-4) : "—";

      const payMonth = payroll.month ?? "";
      const [payYearStr, payMonthStr] = payMonth.split("-");
      const workingDays = payMonth
        ? new Date(Number(payYearStr), Number(payMonthStr), 0).getDate()
        : 30;

      const pdfBuffer = await generatePayslipPdf({
        orgName: org?.legalName ?? org?.name ?? "Company",
        orgAddress: addressLine || undefined,
        employeeName: employee.name ?? "Employee",
        employeeId: employee.employeeId ?? undefined,
        designation: employee.designation ?? undefined,
        department: employee.team ?? employee.role ?? undefined,
        panNumber: employee.taxId ? decrypt(employee.taxId) : undefined,
        pfUan: bank?.pfUanNumber || undefined,
        bankName: bank?.bankName ?? undefined,
        maskedAccount,
        ifsc: bank?.ifsc ?? undefined,
        joiningDate: employee.joiningDate ? formatJoiningDate(employee.joiningDate) : undefined,
        monthLabel,
        workingDays,
        basicSalary: basic,
        hra,
        allowances,
        overtimeAmount,
        grossSalary,
        deductions,
        netSalary,
      });

      const { subject: payslipSubject, html } = getPayslipEmailTemplate({
        employeeName: employee.name ?? "Employee",
        month: monthLabel,
        netSalary: netSalary.toLocaleString("en-IN", { minimumFractionDigits: 2 }),
        orgName: org?.name ?? "Company",
      });

      await this.email.sendEmail({
        to: employee.email,
        subject: payslipSubject,
        html,
        attachments: [
          {
            filename: `Payslip-${(employee.name ?? "employee").replace(/\s+/g, "-")}-${payroll.month ?? "unknown"}.pdf`,
            content: pdfBuffer,
            type: "application/pdf",
          },
        ],
      });
    } catch (error) {
      logger.error("Failed to send payslip email", { payrollId: payroll.id, error });
    }
  }
}
