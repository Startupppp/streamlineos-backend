import { pgEnum } from "drizzle-orm/pg-core";

export const payrollTemplateCategoryEnum = pgEnum("payroll_template_category", [
  "INDIAN_STANDARD", "INDIAN_STARTUP", "CONTRACTOR", "SALES_INCENTIVE",
  "GLOBAL_REMOTE", "HOURLY", "MANUFACTURING", "STAFFING", "EXECUTIVE", "CUSTOM",
]);

export const payrollInputSourceEnum = pgEnum("payroll_input_source", [
  "ATTENDANCE", "LEAVE", "TIMESHEET", "UPLOAD", "MANUAL",
]);

export const payrollRunEventTypeEnum = pgEnum("payroll_run_event_type", [
  "GENERATED", "RECALCULATED", "APPROVAL_SUBMITTED", "APPROVED", "REJECTED",
  "LOCKED", "REOPENED", "MARKED_PAID", "PAYSLIPS_PUBLISHED",
  "BANK_BATCH_GENERATED", "EXCEPTION_OVERRIDDEN", "INPUT_OVERRIDDEN", "CLOSED",
]);

export const payslipPublicationStatusEnum = pgEnum("payslip_publication_status", [
  "PENDING", "PUBLISHED", "FAILED",
]);

export const payrollTaxWindowStatusEnum = pgEnum("payroll_tax_window_status", [
  "DRAFT", "OPEN", "CLOSED", "LOCKED",
]);
