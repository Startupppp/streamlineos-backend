/**
 * People enums: the HR employee lifecycle, the hiring pipeline, and payroll.
 *
 * Split out of `enums.ts` verbatim. They are one domain — a resignation, an
 * offer and a payroll run are the same person's record at three moments — and
 * they are consumed by `hr/`, `directory/` and `payroll/` and by nothing else.
 * Re-exported from `./enums`, which stays the import path every caller uses.
 */

import { pgEnum } from "drizzle-orm/pg-core";

export const leaveStatusEnum = pgEnum("leave_status", ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
export const expenseStatusEnum = pgEnum("expense_status", ["DRAFT", "SUBMITTED", "PENDING", "APPROVED", "REJECTED", "REIMBURSEMENT_PENDING", "REIMBURSED", "PAID"]);
export const assetStatusEnum = pgEnum("asset_status", ["AVAILABLE", "ASSIGNED", "MAINTENANCE", "RETIRED"]);
export const documentTypeEnum = pgEnum("document_type", ["CONTRACT", "CERTIFICATE", "ID_PROOF", "PAYSLIP", "POLICY", "OFFER_LETTER", "RESUME", "OTHER"]);
export const reviewStatusEnum = pgEnum("review_status", ["DRAFT", "IN_PROGRESS", "COMPLETED", "ARCHIVED"]);
export const onboardingStatusEnum = pgEnum("onboarding_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "REJECTED"]);
export const genderEnum = pgEnum("gender", ["MALE", "FEMALE", "OTHER"]);
export const wfhRequestStatusEnum = pgEnum("wfh_request_status", ["PENDING", "APPROVED", "REJECTED"]);
export const deviceStatusEnum = pgEnum("device_status", ["ACTIVE", "INACTIVE", "LOST", "RETURNED"]);
export const reviewCycleStatusEnum = pgEnum("review_cycle_status", ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]);
export const meetingStatusEnum = pgEnum("meeting_status", ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
export const resignationStatusEnum = pgEnum("resignation_status", ["SUBMITTED", "PENDING_HR", "HR_APPROVED", "FINAL_APPROVED", "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED"]);
export const exitChecklistStatusEnum = pgEnum("exit_checklist_status", ["PENDING", "DONE"]);
export const ackStatusEnum = pgEnum("ack_status", ["PENDING", "ACKNOWLEDGED", "DECLINED"]);
export const reimbursementStatusEnum = pgEnum("reimbursement_status", ["PENDING", "APPROVED", "REJECTED", "PAID"]);
export const loanStatusEnum = pgEnum("loan_status", ["PENDING", "APPROVED", "ACTIVE", "REPAID", "REJECTED"]);
export const pipStatusEnum = pgEnum("pip_status", ["ACTIVE", "EXTENDED", "COMPLETED", "TERMINATED"]);
export const surveyStatusEnum = pgEnum("survey_status", ["DRAFT", "ACTIVE", "CLOSED"]);
export const feedbackTypeEnum = pgEnum("feedback_type", ["SELF", "PEER", "MANAGER", "SKIP_LEVEL"]);
export const bonusTypeEnum = pgEnum("bonus_type", ["PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL", "JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT"]);
export const fnfStatusEnum = pgEnum("fnf_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID", "HR_REVIEW", "FINANCE_REVIEW"]);
export const terminationStatusEnum = pgEnum("termination_status", ["DRAFT", "PENDING_FINAL", "APPROVED", "REJECTED", "SENT", "COMPLETED"]);
export const onboardingDocStatusEnum = pgEnum("onboarding_doc_status", ["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]);
export const onboardingDocumentStatusEnum = pgEnum("onboarding_document_status", ["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]);
export const docAuditActionEnum = pgEnum("doc_audit_action", ["UPLOADED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED", "RE_UPLOADED"]);

export const jobPostingStatusEnum = pgEnum("job_posting_status", ["DRAFT", "OPEN", "PAUSED", "CLOSED", "FILLED"]);
export const candidateStatusEnum = pgEnum("candidate_status", ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"]);
export const interviewTypeEnum = pgEnum("interview_type", ["PHONE", "VIDEO", "ONSITE", "TECHNICAL", "HR", "FINAL"]);
export const interviewResultEnum = pgEnum("interview_result", ["PENDING", "PASSED", "FAILED", "NO_SHOW"]);
export const applicationStatusEnum = pgEnum("application_status", ["APPLIED", "SHORTLISTED", "INTERVIEWING", "OFFERED", "ACCEPTED", "REJECTED", "WITHDRAWN"]);

export const payrollRunStatusEnum = pgEnum("payroll_run_status", [
  "PREPARING", "DRAFT", "PREVIEW_READY", "EXCEPTIONS_FOUND", "PENDING_APPROVAL",
  "APPROVED", "LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED", "REOPENED",
]);

export const payrollWorkerTypeEnum = pgEnum("payroll_worker_type", [
  "EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR",
]);

export const salaryComponentTypeEnum = pgEnum("salary_component_type", [
  "EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT",
]);

export const salaryComponentCalcMethodEnum = pgEnum("salary_component_calc_method", [
  "FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA",
  "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL",
]);

export const payrollExceptionSeverityEnum = pgEnum("payroll_exception_severity", [
  "BLOCKER", "WARNING", "INFO",
]);

export const payrollExceptionStatusEnum = pgEnum("payroll_exception_status", [
  "OPEN", "RESOLVED", "OVERRIDDEN",
]);

export const payrollApprovalStatusEnum = pgEnum("payroll_approval_status", [
  "PENDING", "APPROVED", "REJECTED",
]);

export const payrollBankBatchStatusEnum = pgEnum("payroll_bank_batch_status", [
  "DRAFT", "GENERATED", "SENT", "PARTIALLY_PAID", "PAID", "FAILED",
]);

export const payrollBankItemStatusEnum = pgEnum("payroll_bank_item_status", [
  "PENDING", "SENT", "PAID", "FAILED", "HELD",
]);

export const payrollPolicyStatusEnum = pgEnum("payroll_policy_status", [
  "DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED",
]);

export const salaryProfileStatusEnum = pgEnum("salary_profile_status", [
  "UPCOMING", "ACTIVE", "SUPERSEDED",
]);

export const payFrequencyEnum = pgEnum("pay_frequency", [
  "MONTHLY", "SEMI_MONTHLY", "BI_WEEKLY", "WEEKLY",
]);

export const taxRegimeTypeEnum = pgEnum("tax_regime_type", [
  "OLD", "NEW",
]);

export const payslipLayoutEnum = pgEnum("payslip_layout", [
  "CLASSIC", "MODERN", "COMPLIANCE",
]);

export const payslipPublishChannelEnum = pgEnum("payslip_publish_channel", [
  "PORTAL", "EMAIL",
]);

export const payrollCalendarEventTypeEnum = pgEnum("payroll_calendar_event_type", [
  "ATTENDANCE_CUTOFF", "REIMBURSEMENT_CUTOFF", "DECLARATION_CUTOFF",
  "PREVIEW_DUE", "APPROVAL_DEADLINE", "PAY_DATE", "PUBLISH_DATE",
]);

export const payrollLoanAdjustmentTypeEnum = pgEnum("payroll_loan_adjustment_type", [
  "SKIP_EMI", "EXTRA_RECOVERY", "FORECLOSURE", "MANUAL_ADJUST",
]);
