import { getPayslipEmailTemplate } from "..";
import { EMAIL_TEMPLATE_VERSION, defineTemplateFamily } from "./_shared";
import { PAYSLIP_TEMPLATE_LOCALES } from "../payroll";

export const payrollTemplates = defineTemplateFamily({
  "payroll.payslip": {
    category: "Payroll",
    name: "Payslip",
    subject: (locale: string) =>
      getPayslipEmailTemplate({
        employeeName: "Priya Sharma",
        month: "June 2026",
        orgName: "Acme Corp",
        locale,
      }).subject,
    generateHtml: (locale?: string) =>
      getPayslipEmailTemplate({
        employeeName: "Priya Sharma",
        month: "June 2026",
        orgName: "Acme Corp",
        locale,
      }).html,
    supportedLocales: PAYSLIP_TEMPLATE_LOCALES,
  },
}, EMAIL_TEMPLATE_VERSION);
