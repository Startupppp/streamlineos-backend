import type { PayrollToggles } from "../../payroll.types";

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  href: string;
  detail: string | null;
}

export function buildActivationChecklist(toggles: PayrollToggles): ChecklistItem[] {
  return [
    {
      key: "employees_verified",
      label: "Verify employee profiles",
      done: false,
      href: "/payroll/employees",
      detail: null,
    },
    {
      key: "invite_employees_configured",
      label: "Invite employees & configure self-service",
      done: false,
      href: "/settings/roles",
      detail: "Configure employee self-service options and invite your team",
    },
    {
      key: "attendance_imported",
      label: "Import attendance data",
      done: false,
      href: "/payroll/attendance",
      detail: null,
    },
    {
      key: "reimbursements_approved",
      label: "Approve reimbursements",
      done: !toggles.reimbursements,
      href: "/payroll/reimbursements",
      detail: null,
    },
    {
      key: "variable_pay_approved",
      label: "Approve variable pay",
      done: !toggles.salesIncentives && !toggles.bonuses,
      href: "/payroll/variable",
      detail: null,
    },
    {
      key: "loans_applied",
      label: "Apply loan deductions",
      done: !toggles.loans,
      href: "/payroll/loans",
      detail: null,
    },
    {
      key: "tax_declarations_locked",
      label: "Lock tax declarations",
      done: !toggles.tds,
      href: "/payroll/tax",
      detail: null,
    },
    {
      key: "preview_generated",
      label: "Generate payroll preview",
      done: false,
      href: "/payroll/runs",
      detail: null,
    },
    {
      key: "exceptions_resolved",
      label: "Resolve exceptions",
      done: false,
      href: "/payroll/runs",
      detail: null,
    },
    {
      key: "payroll_approved",
      label: "Approve payroll run",
      done: !toggles.approvalWorkflow,
      href: "/payroll/runs",
      detail: null,
    },
    {
      key: "bank_file_generated",
      label: "Generate bank payout file",
      done: !toggles.bankPayoutFile,
      href: "/payroll/payout",
      detail: null,
    },
    {
      key: "payslips_published",
      label: "Publish payslips",
      done: !toggles.payslipPublishing,
      href: "/payroll/payslips",
      detail: null,
    },
  ];
}
