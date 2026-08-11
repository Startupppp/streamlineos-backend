import { getPayslipEmailTemplate } from "../index";
import type { TemplateEntry } from "./_shared";

export const payrollTemplates: Record<string, TemplateEntry> = {
  "payroll.payslip": {
    category: "Payroll",
    name: "Payslip",
    subject: "Your payslip for June 2026",
    generateHtml: () =>
      getPayslipEmailTemplate({
        employeeName: "Priya Sharma",
        month: "June 2026",
        orgName: "Acme Corp",
      }).html,
  },
};
