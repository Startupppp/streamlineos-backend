import { pgEnum } from "drizzle-orm/pg-core";

export const timesheetEntryStatusEnum = pgEnum("timesheet_entry_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const timesheetPayrollStatusEnum = pgEnum("timesheet_payroll_status", [
  "UNPROCESSED",
  "EXPORTED",
]);

export const timesheetBillingTypeEnum = pgEnum("timesheet_billing_type", [
  "BILLABLE",
  "NON_BILLABLE",
  "FIXED",
]);

export const timesheetInvoicingStatusEnum = pgEnum("timesheet_invoicing_status", [
  "UNINVOICED",
  "INVOICE_DRAFTED",
  "INVOICED",
]);

export const timesheetRateSourceEnum = pgEnum("timesheet_rate_source", [
  "RATE_CARD",
  "PROJECT_MEMBER",
]);

export const timesheetEntrySourceEnum = pgEnum("timesheet_entry_source", [
  "MANUAL",
  "TIMER",
  "API",
  "IMPORT",
]);

export const timesheetPeriodStatusEnum = pgEnum("timesheet_period_status", [
  "OPEN",
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "LOCKED",
]);

export const timerSessionStatusEnum = pgEnum("timer_session_status", [
  "RUNNING",
  "PAUSED",
  "STOPPED",
  "CONVERTED",
  "DISCARDED",
]);

export const timerSessionSourceEnum = pgEnum("timer_session_source", [
  "WEB",
  "MOBILE",
  "DESKTOP",
  "API",
]);

export const timesheetBudgetTypeEnum = pgEnum("timesheet_budget_type", [
  "HOURS",
  "AMOUNT",
]);

export const timesheetBudgetStatusEnum = pgEnum("timesheet_budget_status", [
  "ACTIVE",
  "ARCHIVED",
]);

export const timesheetExportTypeEnum = pgEnum("timesheet_export_type", [
  "PAYROLL",
  "BILLING",
  "INVOICE_DRAFT",
]);

export const timesheetExportStatusEnum = pgEnum("timesheet_export_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

export const timesheetExportFormatEnum = pgEnum("timesheet_export_format", [
  "CSV",
  "XLSX",
  "JSON",
  "PDF",
]);

export const timesheetRoundingRuleEnum = pgEnum("timesheet_rounding_rule", [
  "NONE",
  "NEAREST_5",
  "NEAREST_6",
  "NEAREST_10",
  "NEAREST_15",
  "ROUND_UP",
  "ROUND_DOWN",
]);

export const timesheetApprovalModeEnum = pgEnum("timesheet_approval_mode", [
  "MANAGER",
  "AUTO",
  "MULTI_LEVEL",
]);

export const timesheetApproverSourceEnum = pgEnum("timesheet_approver_source", [
  "REPORTING_MANAGER",
  "PROJECT_MANAGER",
]);

export const timesheetPayPeriodEnum = pgEnum("timesheet_pay_period", [
  "WEEKLY",
  "BIWEEKLY",
  "SEMIMONTHLY",
  "MONTHLY",
]);
