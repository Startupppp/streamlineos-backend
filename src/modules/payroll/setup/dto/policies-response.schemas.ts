import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const payrollPolicyRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  status: z.enum(["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"]),
  country: z.string(),
  state: z.string().nullable(),
  legalEntityName: z.string().nullable(),
  currency: z.string(),
  payFrequency: z.enum(["MONTHLY", "SEMI_MONTHLY", "BI_WEEKLY", "WEEKLY"]),
  payDay: z.number().int(),
  employeeCount: z.number().int().nullable(),
  startMonth: z.string(),
  activeVersionId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payrollPolicyVersionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  policyId: z.number().int(),
  version: z.number().int(),
  templateKey: z.string().nullable(),
  toggles: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"]),
  effectiveFrom: z.string(),
  reason: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const getCurrentStatutoryPackSchema = z.object({
  country: z.string(),
  items: z.array(z.object({
    key: z.string(),
    enabled: z.boolean(),
    percentOverride: z.string().optional(),
    label: z.string(),
    kind: z.string().nullable(),
  })),
  complianceChecklist: z.array(z.object({
    key: z.string(),
    label: z.string(),
    detail: z.string(),
  })),
});

export const policyCurrentResponseSchema = z.object({
  policy: payrollPolicyRowSchema.nullable(),
  activeVersion: payrollPolicyVersionRowSchema.nullable().optional(),
  taxRegimeApplicable: z.boolean().optional(),
  statutoryPack: getCurrentStatutoryPackSchema.nullable().optional(),
});

export const payrollTogglesSchema = z.object({
  pf: z.boolean(),
  esi: z.boolean(),
  professionalTax: z.boolean(),
  tds: z.boolean(),
  gratuity: z.boolean(),
  lwf: z.boolean(),
  lopFromAttendance: z.boolean(),
  overtime: z.boolean(),
  timesheets: z.boolean(),
  leaveSync: z.boolean(),
  expenseSync: z.boolean(),
  salesIncentives: z.boolean(),
  manualAdjustments: z.boolean(),
  reimbursements: z.boolean(),
  bonuses: z.boolean(),
  incentives: z.boolean(),
  loans: z.boolean(),
  contractorPayments: z.boolean(),
  multiCurrency: z.boolean(),
  employeeDeclarations: z.boolean(),
  payrollVarianceWarnings: z.boolean(),
  requireLockedPayrollInputs: z.boolean(),
  countryComplianceChecklist: z.boolean(),
  globalPaymentReport: z.boolean(),
  bankPayoutFile: z.boolean(),
  payslipPublishing: z.boolean(),
  emailPayslips: z.boolean(),
  approvalWorkflow: z.boolean(),
  managerApproval: z.boolean(),
  financeApproval: z.boolean(),
  lockAfterApproval: z.boolean(),
  essShowSalaryStructure: z.boolean(),
  essAllowBankUpdate: z.boolean(),
  essAllowLoanRequests: z.boolean(),
  essAllowTaxDeclarations: z.boolean(),
  essAllowReimbursements: z.boolean(),
});

const approvalStageSchema = z.object({
  stage: z.number().int(),
  stageName: z.string(),
  requiredPermission: z.string(),
});

const calendarPlanItemSchema = z.object({
  orgId: z.string(),
  policyId: z.number().int(),
  month: z.string(),
  type: z.enum([
    "ATTENDANCE_CUTOFF", "REIMBURSEMENT_CUTOFF", "DECLARATION_CUTOFF",
    "PREVIEW_DUE", "APPROVAL_DEADLINE", "PAY_DATE", "PUBLISH_DATE",
  ]),
  date: z.string(),
  title: z.string(),
});

const previewComponentSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT"]),
  calcMethod: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA", "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL"]),
  amount: z.string().nullable(),
  percent: z.string().nullable(),
  formula: z.string().nullable(),
  taxable: z.boolean(),
  showOnPayslip: z.boolean(),
  includeInCtc: z.boolean(),
  isStatutory: z.boolean(),
  statutoryKey: z.string().nullable(),
  sortOrder: z.number().int(),
});

const previewCalcSchema = z.object({
  method: z.enum(["PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FIXED", "BRACKETS"]),
  percent: z.string().optional(),
  employerPercent: z.string().optional(),
  fixedAmount: z.string().optional(),
  wageCeilingMonthly: z.string().nullable().optional(),
  wageFloorMonthly: z.string().nullable().optional(),
  brackets: z.array(z.object({ upToMonthly: z.string().nullable(), percent: z.string() })).optional(),
});

const previewStatutoryPackSchema = z.object({
  country: z.string(),
  countryName: z.string(),
  currency: z.string(),
  taxRegimeApplicable: z.boolean(),
  items: z.array(z.object({
    key: z.string(),
    label: z.string(),
    kind: z.string().nullable(),
    componentCode: z.string(),
    enabled: z.boolean(),
    calc: previewCalcSchema,
    note: z.string().optional(),
  })),
  complianceChecklist: z.array(z.object({
    key: z.string(),
    label: z.string(),
    detail: z.string(),
  })),
});

export const policyPreviewResponseSchema = z.object({
  toggles: payrollTogglesSchema,
  components: z.array(previewComponentSchema),
  approvalChain: z.array(approvalStageSchema),
  calendarPlan: z.array(calendarPlanItemSchema),
  essOptions: z.object({
    showSalaryStructure: z.boolean(),
    allowBankUpdate: z.boolean(),
    allowLoanRequests: z.boolean(),
    allowTaxDeclarations: z.boolean(),
    allowReimbursements: z.boolean(),
  }),
  statutoryPack: previewStatutoryPackSchema,
});

const checklistItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
  href: z.string(),
  detail: z.string().nullable(),
});

export const policyActivateResponseSchema = z.object({
  policyVersion: payrollPolicyVersionRowSchema.optional(),
  componentCount: z.number().int(),
  checklist: z.array(checklistItemSchema),
});

export const policyToggleImpactResponseSchema = z.object({
  toggle: z.string(),
  affectedEmployeeCount: z.number().int(),
  affectedStatutoryCodes: z.array(z.string()),
});

export const policyVersionsListResponseSchema = z.array(payrollPolicyVersionRowSchema);
