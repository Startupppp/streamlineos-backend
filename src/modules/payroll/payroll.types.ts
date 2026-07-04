import {
  payFrequencyEnum,
  payrollApprovalStatusEnum,
  payrollBankBatchStatusEnum,
  payrollBankItemStatusEnum,
  payrollCalendarEventTypeEnum,
  payrollExceptionSeverityEnum,
  payrollExceptionStatusEnum,
  payrollInputSourceEnum,
  payrollRunEventTypeEnum,
  payrollRunStatusEnum,
  payrollTemplateCategoryEnum,
  payrollWorkerTypeEnum,
  payslipLayoutEnum,
  payslipPublishChannelEnum,
  salaryComponentCalcMethodEnum,
  salaryComponentTypeEnum,
  taxRegimeTypeEnum,
} from "../../db/schema";

export type PayrollRunStatus = (typeof payrollRunStatusEnum.enumValues)[number];
export type PayrollWorkerType = (typeof payrollWorkerTypeEnum.enumValues)[number];
export type SalaryComponentType = (typeof salaryComponentTypeEnum.enumValues)[number];
export type SalaryComponentCalcMethod = (typeof salaryComponentCalcMethodEnum.enumValues)[number];
export type PayrollExceptionSeverity = (typeof payrollExceptionSeverityEnum.enumValues)[number];
export type PayrollExceptionStatus = (typeof payrollExceptionStatusEnum.enumValues)[number];
export type PayrollApprovalStatus = (typeof payrollApprovalStatusEnum.enumValues)[number];
export type PayrollBankBatchStatus = (typeof payrollBankBatchStatusEnum.enumValues)[number];
export type PayrollBankItemStatus = (typeof payrollBankItemStatusEnum.enumValues)[number];
export type PayFrequency = (typeof payFrequencyEnum.enumValues)[number];
export type TaxRegimeType = (typeof taxRegimeTypeEnum.enumValues)[number];
export type PayslipLayout = (typeof payslipLayoutEnum.enumValues)[number];
export type PayslipPublishChannel = (typeof payslipPublishChannelEnum.enumValues)[number];
export type PayrollCalendarEventType = (typeof payrollCalendarEventTypeEnum.enumValues)[number];
export type PayrollInputSource = (typeof payrollInputSourceEnum.enumValues)[number];
export type PayrollRunEventType = (typeof payrollRunEventTypeEnum.enumValues)[number];
export type PayrollTemplateCategory = (typeof payrollTemplateCategoryEnum.enumValues)[number];

export type MoneyString = string;

export const PAYROLL_TEMPLATE_KEYS = [
  "INDIAN_STANDARD",
  "INDIAN_STARTUP",
  "CONTRACTOR",
  "SALES_INCENTIVE",
  "GLOBAL_REMOTE",
  "HOURLY",
  "MANUFACTURING",
  "STAFFING",
  "EXECUTIVE",
  "US_STANDARD",
  "UK_STANDARD",
  "UAE_STANDARD",
  "SG_STANDARD",
  "AU_STANDARD",
] as const;
export type PayrollTemplateKey = (typeof PAYROLL_TEMPLATE_KEYS)[number];

export const PAYROLL_TOGGLE_KEYS = [
  "pf",
  "esi",
  "professionalTax",
  "tds",
  "gratuity",
  "lwf",
  "lopFromAttendance",
  "overtime",
  "timesheets",
  "leaveSync",
  "expenseSync",
  "salesIncentives",
  "manualAdjustments",
  "reimbursements",
  "bonuses",
  "incentives",
  "loans",
  "contractorPayments",
  "multiCurrency",
  "employeeDeclarations",
  "payrollVarianceWarnings",
  "countryComplianceChecklist",
  "globalPaymentReport",
  "bankPayoutFile",
  "payslipPublishing",
  "emailPayslips",
  "approvalWorkflow",
  "managerApproval",
  "financeApproval",
  "lockAfterApproval",
  "essShowSalaryStructure",
  "essAllowBankUpdate",
  "essAllowLoanRequests",
  "essAllowTaxDeclarations",
  "essAllowReimbursements",
] as const;
export type PayrollToggleKey = (typeof PAYROLL_TOGGLE_KEYS)[number];
export type PayrollToggles = Record<PayrollToggleKey, boolean>;

export const DEFAULT_PAYROLL_TOGGLES: PayrollToggles = {
  pf: false,
  esi: false,
  professionalTax: false,
  tds: false,
  gratuity: false,
  lwf: false,
  lopFromAttendance: true,
  overtime: false,
  timesheets: false,
  leaveSync: true,
  expenseSync: false,
  salesIncentives: false,
  manualAdjustments: true,
  reimbursements: false,
  bonuses: false,
  incentives: false,
  loans: false,
  contractorPayments: false,
  multiCurrency: false,
  employeeDeclarations: false,
  payrollVarianceWarnings: true,
  countryComplianceChecklist: false,
  globalPaymentReport: false,
  bankPayoutFile: true,
  payslipPublishing: true,
  emailPayslips: false,
  approvalWorkflow: true,
  managerApproval: false,
  financeApproval: false,
  lockAfterApproval: true,
  essShowSalaryStructure: false,
  essAllowBankUpdate: false,
  essAllowLoanRequests: false,
  essAllowTaxDeclarations: false,
  essAllowReimbursements: true,
};

export interface TemplateComponentDef {
  code: string;
  name: string;
  type: SalaryComponentType;
  calcMethod: SalaryComponentCalcMethod;
  amount?: MoneyString;
  percent?: string;
  formula?: string;
  taxable: boolean;
  showOnPayslip: boolean;
  includeInCtc: boolean;
  isStatutory: boolean;
  statutoryKey?: string;
  sortOrder: number;
}

export interface PayrollApprovalStageDef {
  stage: number;
  stageName: string;
  requiredPermission: string;
}

export interface StatutoryPackItemConfig {
  key: string;
  enabled: boolean;
  percentOverride?: string;
}

export interface StatutoryPackConfig {
  country: string;
  items: StatutoryPackItemConfig[];
}

export interface PayrollPolicyConfig {
  components: TemplateComponentDef[];
  rounding: { mode: "NEAREST" | "UP" | "DOWN"; precision: 0 | 2 };
  approvalChain: PayrollApprovalStageDef[];
  payslipLayout: PayslipLayout;
  calendar: {
    attendanceCutoffDay: number;
    reimbursementCutoffDay: number;
    declarationCutoffDay: number;
    previewDay: number;
    approvalDeadlineDay: number;
    publishOffsetDays: number;
  };
  statutory: {
    pfEmployeePercent: string;
    pfEmployerPercent: string;
    pfWageCeiling: MoneyString | null;
    esiEmployeePercent: string;
    esiEmployerPercent: string;
    esiWageCeiling: MoneyString | null;
    professionalTaxMonthly: MoneyString;
    tdsMode: "DECLARATION" | "FLAT" | "NONE";
    tdsFlatPercent: string | null;
  };
  statutoryPack?: StatutoryPackConfig;
  overtime: { multiplier: string; basis: "BASIC" | "GROSS" };
  varianceThresholdPercent: number;
}

export interface PayrollTemplateSeed {
  key: PayrollTemplateKey;
  name: string;
  description: string;
  bestFor: string;
  complexity: "SIMPLE" | "MODERATE" | "ADVANCED";
  badge: string | null;
  category: PayrollTemplateCategory;
  isRecommended: boolean;
  defaultToggles: PayrollToggles;
  defaultComponents: TemplateComponentDef[];
}

export const FORMULA_VARIABLES = [
  "basic",
  "gross",
  "ctc",
  "days_in_month",
  "paid_days",
  "lop_days",
  "overtime_hours",
  "incentive_amount",
  "reimbursement_amount",
] as const;
export type FormulaVariable = (typeof FORMULA_VARIABLES)[number];
export type FormulaScope = Record<FormulaVariable, number>;

export interface CalcExplain {
  method: SalaryComponentCalcMethod;
  formula?: string;
  inputs: Record<string, number>;
  steps: string[];
  note?: string;
}

export interface CalculationSnapshotLine {
  code: string;
  name: string;
  category: SalaryComponentType;
  amount: MoneyString;
  calcMethod: SalaryComponentCalcMethod;
  taxable: boolean;
  sortOrder: number;
  explain: CalcExplain;
}

export interface RunEmployeeVariance {
  previousRunId: number | null;
  previousNet: MoneyString | null;
  netDelta: MoneyString | null;
  netDeltaPercent: number | null;
  changedComponents: { code: string; previous: MoneyString | null; current: MoneyString | null }[];
}

export interface CalculationSnapshot {
  policyVersionId: number | null;
  computedAt: string;
  currency: string;
  scheduledDays: string;
  paidDays: string;
  lopDays: string;
  overtimeHours: string;
  lines: CalculationSnapshotLine[];
  totals: {
    gross: MoneyString;
    deductions: MoneyString;
    employerContributions: MoneyString;
    net: MoneyString;
  };
  variance: RunEmployeeVariance | null;
}

export interface InputsSnapshot {
  source: PayrollInputSource;
  scheduledDays: string;
  paidDays: string;
  lopDays: string;
  halfDays: string;
  overtimeHours: string;
  shiftAllowanceUnits: string;
  holidayWorkDays: string;
  billableHours: string;
  isOverride: boolean;
  overrideReason: string | null;
}

export const PAYROLL_RUN_TRANSITIONS: Record<PayrollRunStatus, readonly PayrollRunStatus[]> = {
  PREPARING: ["DRAFT"],
  DRAFT: ["PREVIEW_READY", "EXCEPTIONS_FOUND"],
  PREVIEW_READY: ["PENDING_APPROVAL", "DRAFT", "EXCEPTIONS_FOUND"],
  EXCEPTIONS_FOUND: ["PREVIEW_READY", "DRAFT", "PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "PREVIEW_READY"],
  APPROVED: ["LOCKED"],
  LOCKED: ["PAID", "REOPENED"],
  PAID: ["PAYSLIPS_PUBLISHED"],
  PAYSLIPS_PUBLISHED: ["CLOSED"],
  CLOSED: [],
  REOPENED: ["DRAFT"],
};

export function canTransitionRun(from: PayrollRunStatus, to: PayrollRunStatus): boolean {
  return PAYROLL_RUN_TRANSITIONS[from].includes(to);
}

export const PAYROLL_LOCKED_STATUSES: readonly PayrollRunStatus[] = [
  "LOCKED",
  "PAID",
  "PAYSLIPS_PUBLISHED",
  "CLOSED",
];

export const PAYROLL_EXCEPTION_CODES = {
  MISSING_SALARY_PROFILE: "BLOCKER",
  MISSING_BANK_ACCOUNT: "BLOCKER",
  INVALID_BANK_IFSC: "BLOCKER",
  DUPLICATE_BANK_ACCOUNT: "WARNING",
  NEGATIVE_NET_PAY: "BLOCKER",
  ZERO_NET_PAY: "WARNING",
  SALARY_ON_HOLD: "WARNING",
  MISSING_ATTENDANCE_INPUT: "WARNING",
  LOP_EXCEEDS_SCHEDULED_DAYS: "BLOCKER",
  FORMULA_ERROR: "BLOCKER",
  HIGH_VARIANCE: "WARNING",
  MISSING_FX_RATE: "BLOCKER",
  PENDING_TAX_DECLARATION: "INFO",
  MID_PERIOD_JOINER: "INFO",
  MID_PERIOD_EXIT: "INFO",
} as const satisfies Record<string, PayrollExceptionSeverity>;
export type PayrollExceptionCode = keyof typeof PAYROLL_EXCEPTION_CODES;

export interface PayrollChecklistItem {
  key:
    | "employees_verified"
    | "attendance_imported"
    | "reimbursements_approved"
    | "variable_pay_approved"
    | "loans_applied"
    | "tax_declarations_locked"
    | "preview_generated"
    | "exceptions_resolved"
    | "payroll_approved"
    | "bank_file_generated"
    | "payslips_published";
  label: string;
  done: boolean;
  href: string | null;
  detail: string | null;
}
