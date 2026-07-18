import { z } from "zod";

export const generatePayrollSchema = z.object({
  month: z.string().optional(),
});
export type GeneratePayrollInput = z.infer<typeof generatePayrollSchema>;

export const generateSinglePayrollSchema = z.object({
  userId: z.string(),
  month: z.string(),
  lopDays: z.number().min(0).optional(),
  halfDays: z.number().min(0).optional(),
  otherDeductions: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  overtimeType: z.enum(["days", "hours"]).optional(),
  overtimeDays: z.number().min(0).optional(),
  overtimeHours: z.number().min(0).optional(),
  overtimeAmount: z.number().min(0).optional(),
});
export type GenerateSinglePayrollInput = z.infer<typeof generateSinglePayrollSchema>;

export const allPayrollsQuerySchema = z.object({
  month: z.string().optional(),
  year: z.string().optional(),
});
export type AllPayrollsQueryInput = z.infer<typeof allPayrollsQuerySchema>;

export const payrollReportsQuerySchema = z.object({
  year: z.string().optional(),
  type: z.string().optional(),
});
export type PayrollReportsQueryInput = z.infer<typeof payrollReportsQuerySchema>;

export const payslipsQuerySchema = z.object({
  userId: z.string().optional(),
});
export type PayslipsQueryInput = z.infer<typeof payslipsQuerySchema>;

export const createBonusSchema = z.object({
  userId: z.string().min(1),
  type: z.enum([
    "PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL",
    "JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT",
  ]),
  amount: z.preprocess(
    (val) => {
      const n = typeof val === "string" ? parseFloat(val) : val;
      return typeof n === "number" && isFinite(n) ? n : NaN;
    },
    z
      .number()
      .positive("Amount must be positive")
      .multipleOf(0.01, "Amount must have at most 2 decimal places"),
  ),
  reason: z
    .string()
    .max(500, "Reason must be at most 500 characters")
    .refine((v) => !v || v.trim().length >= 3, "Reason must be at least 3 characters")
    .refine((v) => !v || !/^[\s\W]+$/.test(v.trim()), "Reason cannot consist of only special characters")
    .optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
  taxable: z.boolean().optional(),
});
export type CreateBonusInput = z.infer<typeof createBonusSchema>;

export const patchBonusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PAID"]),
});
export type PatchBonusInput = z.infer<typeof patchBonusSchema>;

export const createLoanSchema = z.object({
  amount: z
    .number()
    .min(1000, "Loan amount must be at least ₹1,000")
    .max(10000000, "Loan amount cannot exceed ₹1,00,00,000"),
  reason: z.string().min(1, "Reason is required").max(500),
  totalEmis: z.number().int().min(1, "At least 1 EMI required").max(360, "Maximum 360 EMIs"),
  userId: z.string().optional(),
});
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

export const updateLoanSchema = z.object({
  status: z.enum(["APPROVED", "ACTIVE", "REPAID", "REJECTED"]).optional(),
  paidEmis: z.number().int().min(0).optional(),
});
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;

export const incentivesQuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type IncentivesQueryInput = z.infer<typeof incentivesQuerySchema>;

export const createIncentiveConfigSchema = z.object({
  incentiveRate: z.preprocess(
    (val) => (typeof val === "string" ? parseFloat(val) : val),
    z
      .number({ message: "Incentive rate must be a number" })
      .positive({ message: "Incentive rate must be positive" })
      .max(100, { message: "Incentive rate cannot exceed 100%" })
      .multipleOf(0.01, { message: "Incentive rate can have at most 2 decimal places" })
      .transform((n) => n.toFixed(2)),
  ),
});
export type CreateIncentiveConfigInput = z.infer<typeof createIncentiveConfigSchema>;

export const approveIncentiveSchema = z.object({
  approvedAmount: z.string(),
  notes: z.string().optional(),
});
export type ApproveIncentiveInput = z.infer<typeof approveIncentiveSchema>;

export const createReimbursementSchema = z.object({
  category: z.string().min(1).max(100),
  amount: z
    .number()
    .min(1, "Amount must be at least ₹1")
    .max(999999, "Amount cannot exceed ₹9,99,999")
    .multipleOf(0.01, "Amount must have at most 2 decimal places"),
  description: z.string().max(1000).optional(),
  receiptUrl: z.string().url("Enter a valid URL (e.g. https://example.com)").optional().or(z.literal("")),
  payrollMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
});
export type CreateReimbursementInput = z.infer<typeof createReimbursementSchema>;

export const patchReimbursementSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PAID"]),
  rejectionReason: z.string().max(500).optional(),
});
export type PatchReimbursementInput = z.infer<typeof patchReimbursementSchema>;

export const createFnfSchema = z.object({
  userId: z.string().min(1),
  resignationId: z.number().int().positive().optional(),
  basicDues: z.number().min(0).optional(),
  leaveEncashment: z.number().min(0).optional(),
  bonusDue: z.number().min(0).optional(),
  deductions: z.number().min(0).optional(),
  loanRecovery: z.number().min(0).optional(),
  reimbursementsDue: z.number().min(0).optional(),
  assetRecovery: z.number().min(0).optional(),
  noticeRecovery: z.number().min(0).optional(),
  otherDeductions: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
});
export type CreateFnfInput = z.infer<typeof createFnfSchema>;

export const patchFnfSchema = z.object({
  status: z.enum(["PENDING_APPROVAL", "APPROVED", "PAID", "HR_REVIEW", "FINANCE_REVIEW"]),
  notes: z.string().optional(),
});
export type PatchFnfInput = z.infer<typeof patchFnfSchema>;

export const accountingExportSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  format: z.enum(["TALLY_XML", "QUICKBOOKS_CSV", "JSON"]).optional().default("JSON"),
});
export type AccountingExportInput = z.infer<typeof accountingExportSchema>;

export const taxCalcSchema = z.object({
  annualCtc: z.number().positive(),
  basicPercentage: z.number().min(0).max(100).optional().default(50),
  hraPercentage: z.number().min(0).max(100).optional().default(40),
  regime: z.enum(["OLD", "NEW"]).optional().default("NEW"),
  pfOptOut: z.boolean().optional().default(false),
});
export type TaxCalcInput = z.infer<typeof taxCalcSchema>;

const bankTransferEntrySchema = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
  bankAccount: z.string().min(1).max(50),
  ifscCode: z.string().min(1).max(20),
  employeeName: z.string().min(1).max(200),
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]).default("PENDING"),
});

export const createBankTransferSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
  totalAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  employeeCount: z.number().int().nonnegative(),
  entries: z.array(bankTransferEntrySchema).min(1),
  bankFileUrl: z.string().url().optional(),
  referenceNo: z.string().max(100).optional(),
});
export type CreateBankTransferInput = z.infer<typeof createBankTransferSchema>;

export const updateBankTransferStatusSchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]),
  referenceNo: z.string().max(100).optional(),
});
export type UpdateBankTransferStatusInput = z.infer<typeof updateBankTransferStatusSchema>;

export const createAllowanceSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  formulaType: z.enum(["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA"]).optional(),
  value: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  cap: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  isTaxable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type CreateAllowanceInput = z.infer<typeof createAllowanceSchema>;

export const updateAllowanceSchema = createAllowanceSchema.partial();
export type UpdateAllowanceInput = z.infer<typeof updateAllowanceSchema>;

const decimalNonNegativeStringSchema = z
  .number()
  .nonnegative()
  .optional()
  .transform((n) => (n === undefined ? undefined : n.toFixed(2)));

export const hrTaxCreateOrUpdateSchema = z.object({
  financialYear: z.string().min(1).max(20),
  regime: z.enum(["OLD", "NEW"]).optional(),
  hra: decimalNonNegativeStringSchema,
  lta: decimalNonNegativeStringSchema,
  section80c: decimalNonNegativeStringSchema,
  section80d: decimalNonNegativeStringSchema,
  section80g: decimalNonNegativeStringSchema,
  homeLoanInterest: decimalNonNegativeStringSchema,
  previousEmploymentIncome: decimalNonNegativeStringSchema,
  previousEmployerTds: decimalNonNegativeStringSchema,
});
export type HrTaxCreateOrUpdateInput = z.infer<typeof hrTaxCreateOrUpdateSchema>;

export const hrTaxAddProofSchema = z.object({
  category: z.string().min(1).max(100),
  amount: z.number().nonnegative().transform((n) => n.toFixed(2)),
  description: z.string().max(500).optional(),
  proofUrl: z.string().url().optional(),
  financialYear: z.string().min(1).max(20).optional(),
});
export type HrTaxAddProofInput = z.infer<typeof hrTaxAddProofSchema>;

export const createTaxWindowBodySchema = z.object({
  financialYear: z.string().min(1),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  proofDeadline: z.string().datetime().optional(),
  lockDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lockDate must be YYYY-MM-DD").optional(),
});
export type CreateTaxWindowBody = z.infer<typeof createTaxWindowBodySchema>;

export const patchTaxWindowBodySchema = z.object({
  opensAt: z.string().datetime().optional(),
  closesAt: z.string().datetime().optional(),
  proofDeadline: z.string().datetime().optional(),
  lockDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lockDate must be YYYY-MM-DD").optional(),
  status: z.enum(["DRAFT", "OPEN", "CLOSED", "LOCKED"]).optional(),
});
export type PatchTaxWindowBody = z.infer<typeof patchTaxWindowBodySchema>;

const salaryTemplateNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters")
  .refine((v) => /[a-zA-Z0-9]/.test(v), "Name must contain at least one letter or digit")
  .transform((v) => v.replace(/\s+/g, " ").trim());

const decimalStringSchema = z.string().refine(
  (v) => v === "" || !isNaN(parseFloat(v)),
  "Must be a valid number",
);

export const createSalaryStructureTemplateSchema = z.object({
  name: salaryTemplateNameSchema,
  basicSalary: decimalStringSchema.refine((v) => v.length > 0, "Basic salary is required"),
  hraPercent: decimalStringSchema,
  specialAllowance: decimalStringSchema.nullable().optional(),
  medicalAllowance: decimalStringSchema.nullable().optional(),
  travelAllowance: decimalStringSchema.nullable().optional(),
  otherAllowances: decimalStringSchema.nullable().optional(),
  pfDeductionPercent: decimalStringSchema.nullable().optional(),
  professionalTax: decimalStringSchema.nullable().optional(),
  effectiveFrom: z.string().min(1, "Effective from is required"),
  effectiveTo: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});
export type CreateSalaryStructureTemplateInput = z.infer<typeof createSalaryStructureTemplateSchema>;

export const updateSalaryStructureTemplateSchema = createSalaryStructureTemplateSchema.partial();
export type UpdateSalaryStructureTemplateInput = z.infer<typeof updateSalaryStructureTemplateSchema>;
